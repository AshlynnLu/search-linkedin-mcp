import { searchCompany } from './google.js';
import { WebCrawler } from './crawler.js';
import { verifyCompanyMatch } from './llm.js';
import * as fs from 'fs';

// 进度更新函数类型
type ProgressUpdateFn = (message: string) => void;

// 简单日志辅助函数，输出到文件
const logToFile = (message: string, isError = false) => {
  try {
    // 日志消息添加时间戳
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    // 追加到日志文件
    fs.appendFileSync('companyVerifier.log', logMessage);
  } catch {
    // 忽略日志错误
  }
};

/**
 * 验证结果项接口
 */
interface VerifiedResultItem {
  url: string;
  title?: string;
  snippet?: string;
  content_preview: string;
  match_result: any; // 匹配结果
  is_fallback?: boolean; // 是否为回退验证结果
}

/**
 * 公司验证结果接口
 */
interface VerificationResult {
  success: boolean;
  message: string;
  results: VerifiedResultItem[];
  best_match?: VerifiedResultItem;
  linkedin: boolean;
  linkedin_url: string | null;
  note?: string; // 添加注释字段，说明验证情况
}

/**
 * 公司验证服务，整合搜索、爬虫和大模型验证功能
 */
export class CompanyVerifier {
  /**
   * 验证公司LinkedIn页面
   * @param companyName 公司名称
   * @param officialWebsite 公司官方网站（可选）
   * @param progressUpdate 可选的进度更新回调函数
   * @returns 验证结果
   */
  public static async verifyCompanyLinkedIn(
    companyName: string,
    officialWebsite?: string,
    progressUpdate?: ProgressUpdateFn
  ): Promise<VerificationResult> {
    try {
      // 发送初始进度更新
      progressUpdate?.(`开始验证公司 ${companyName} 的LinkedIn页面...`);
      
      // 步骤1: 搜索LinkedIn上的公司页面
      logToFile(`开始验证公司LinkedIn页面: ${companyName}${officialWebsite ? `, 官网: ${officialWebsite}` : ''}`);
      logToFile(`搜索公司LinkedIn页面: ${companyName}`);
      
      progressUpdate?.(`正在搜索 ${companyName} 的LinkedIn页面...`);
      const searchResults = await searchCompany(companyName);
      
      logToFile(`搜索结果数量: ${searchResults.length}`);
      if (searchResults.length === 0) {
        logToFile(`未找到${companyName}的LinkedIn页面`);
        progressUpdate?.(`未找到 ${companyName} 的LinkedIn页面`);
        return {
          success: false,
          message: `未找到${companyName}的LinkedIn页面`,
          results: [],
          linkedin: false,
          linkedin_url: null
        };
      }
      
      // 记录所有搜索结果
      searchResults.forEach((result, index) => {
        logToFile(`搜索结果 ${index + 1}: ${result.link}, 标题: ${result.title || '无标题'}`);
      });
      
      // 步骤2: 并发爬取所有页面内容
      logToFile(`开始并发爬取 ${searchResults.length} 个页面`);
      progressUpdate?.(`找到 ${searchResults.length} 个结果，正在爬取页面内容...`);
      
      const urls = searchResults.map(result => result.link);
      
      // 使用并发爬虫爬取所有页面
      const pageContents = await WebCrawler.crawlMultiplePages(urls);
      
      logToFile(`爬取完成，成功爬取 ${pageContents.size} 个页面`);
      progressUpdate?.(`已成功爬取 ${pageContents.size} 个页面，正在验证内容...`);
      
      // 检查是否至少有一个页面爬取成功
      if (pageContents.size === 0) {
        logToFile('所有页面爬取失败', true);
        // 不立即返回错误，尝试使用搜索结果的标题和摘要信息
        logToFile('尝试使用搜索结果的标题和摘要进行验证');
        progressUpdate?.(`页面爬取失败，尝试使用搜索结果进行验证...`);
        
        // 仅使用最相关的第一个结果进行验证
        const bestResult = searchResults[0];
        
        // 构造基本内容用于验证
        const basicContent = `
公司名称: ${bestResult.title || companyName}
URL: ${bestResult.link}
描述: ${bestResult.snippet || '无可用描述'}
        `;
        
        // 使用基本内容进行验证
        logToFile(`使用搜索结果基本信息验证: ${bestResult.link}`);
        progressUpdate?.(`正在验证搜索结果...`);
        
        const matchResult = await verifyCompanyMatch(
          companyName,
          basicContent,
          {
            title: bestResult.title,
            snippet: bestResult.snippet
          },
          officialWebsite
        );
        
        // 记录验证结果
        logToFile(`基本信息验证结果: 匹配度=${matchResult.overall_score}/10, 是否匹配=${matchResult.is_match}`);
        progressUpdate?.(`验证完成，匹配度: ${matchResult.overall_score}/10`);
        
        // 返回基于搜索结果的验证
        const verifiedResult = {
          url: bestResult.link,
          title: bestResult.title,
          snippet: bestResult.snippet,
          content_preview: basicContent.substring(0, 300) + '...',
          match_result: matchResult
        };
        
        return {
          success: true,
          message: matchResult.is_match
            ? `找到${companyName}的可能LinkedIn页面（基于搜索结果）`
            : `未找到${companyName}的可靠官方LinkedIn页面`,
          results: [verifiedResult],
          best_match: verifiedResult,
          linkedin: matchResult.is_match,
          linkedin_url: matchResult.is_match ? bestResult.link : null,
          note: "验证基于搜索结果，未能成功爬取页面内容"
        };
      }
      
      // 步骤3: 处理爬取结果并验证内容
      progressUpdate?.(`开始验证爬取的 ${pageContents.size} 个页面内容...`);
      let verifiedCount = 0;
      
      const verificationPromises = searchResults.map(async (result, index) => {
        const url = result.link;
        const pageContent = pageContents.get(url);
        
        if (!pageContent) {
          logToFile(`结果 ${index + 1} 页面内容为空或爬取失败: ${url}`, true);
          
          // 构造基于搜索结果的基本内容
          const basicContent = `
公司名称: ${result.title || companyName}
URL: ${result.link}
描述: ${result.snippet || '无可用描述'}
          `;
          
          // 使用搜索结果信息进行有限验证
          logToFile(`使用搜索结果信息对结果 ${index + 1} 进行有限验证`);
          try {
            const basicMatchResult = await verifyCompanyMatch(
              companyName,
              basicContent,
              {
                title: result.title,
                snippet: result.snippet
              },
              officialWebsite
            );
            
            logToFile(`结果 ${index + 1} 基本验证结果: 匹配度=${basicMatchResult.overall_score}/10, 是否匹配=${basicMatchResult.is_match}`);
            verifiedCount++;
            progressUpdate?.(`已验证 ${verifiedCount}/${searchResults.length} 个结果...`);
            
            // 返回基于搜索结果的验证，但降低可信度分数
            basicMatchResult.credibility_score = Math.max(1, basicMatchResult.credibility_score - 3);
            basicMatchResult.overall_score = (basicMatchResult.name_score + basicMatchResult.business_score + 
                                            basicMatchResult.credibility_score + basicMatchResult.website_score) / 4;
            basicMatchResult.is_match = basicMatchResult.overall_score >= 7;
            
            return {
              url,
              title: result.title,
              snippet: result.snippet,
              content_preview: `[爬取失败，使用搜索结果信息] ${basicContent.substring(0, 200)}...`,
              match_result: basicMatchResult,
              is_fallback: true // 标记这是基于搜索结果的回退验证
            };
          } catch (error) {
            logToFile(`结果 ${index + 1} 基本验证失败: ${error}`, true);
            return null;
          }
        }
        
        logToFile(`开始验证结果 ${index + 1}: ${url}, 内容长度: ${pageContent.length}字符`);
        
        try {
          // 使用大模型验证内容
          logToFile(`验证页面 ${index + 1} 内容是否与${companyName}匹配`);
          const matchResult = await verifyCompanyMatch(
            companyName,
            pageContent,
            {
              title: result.title,
              snippet: result.snippet
            },
            officialWebsite
          );
          
          // 记录验证结果
          logToFile(`结果 ${index + 1} 验证结果: 匹配度=${matchResult.overall_score}/10, 是否匹配=${matchResult.is_match}`);
          logToFile(`结果 ${index + 1} 详细评分: 名称匹配=${matchResult.name_score}, 业务相关=${matchResult.business_score}, 可信度=${matchResult.credibility_score}, 网站匹配=${matchResult.website_score}`);
          
          if (matchResult.website_found) {
            logToFile(`结果 ${index + 1} 在页面中发现网站: ${matchResult.website_found}`);
          }
          
          verifiedCount++;
          progressUpdate?.(`已验证 ${verifiedCount}/${searchResults.length} 个结果...`);
          
          return {
            url,
            title: result.title,
            snippet: result.snippet,
            content_preview: pageContent.substring(0, 300) + '...',
            match_result: matchResult,
            is_fallback: false // 这不是回退验证
          };
        } catch (error) {
          logToFile(`验证结果 ${index + 1} 失败: ${error instanceof Error ? error.message : String(error)}`, true);
          return null;
        }
      });
      
      // 等待所有验证完成
      const results = await Promise.all(verificationPromises);
      
      // 清理浏览器资源
      await WebCrawler.closeBrowser();
      
      // 过滤掉失败的结果
      const validResults = results.filter(result => result !== null);
      
      if (validResults.length === 0) {
        logToFile('所有验证结果都失败', true);
        progressUpdate?.(`验证失败: 无法验证任何搜索结果`);
        return {
          success: false,
          message: `验证公司LinkedIn页面失败: 无法爬取或验证任何搜索结果`,
          results: [],
          linkedin: false,
          linkedin_url: null
        };
      }
      
      // 按匹配度排序，优先考虑非回退结果
      validResults.sort((a, b) => {
        // 优先考虑非回退结果
        if (a.is_fallback !== b.is_fallback) {
          return a.is_fallback ? 1 : -1;
        }
        
        // 其次按照匹配度排序
        return b.match_result.overall_score - a.match_result.overall_score;
      });
      
      // 找出最佳匹配
      const bestMatch = validResults[0];
      
      // 检查是否有任何结果被认为是公司的LinkedIn主页
      const hasLinkedInMatch = validResults.some(result => result.match_result.is_match);
      
      // 计算有多少结果是基于实际爬取的，有多少是回退的
      const actualResults = validResults.filter(result => !result.is_fallback);
      const fallbackResults = validResults.filter(result => result.is_fallback);
      
      logToFile(`验证完成，找到 ${validResults.length} 个有效结果（${actualResults.length}个实际爬取，${fallbackResults.length}个回退）`);
      logToFile(`最佳匹配: ${bestMatch.url}, 匹配度: ${bestMatch.match_result.overall_score}, 是回退结果: ${bestMatch.is_fallback}`);
      logToFile(`是否找到LinkedIn主页: ${hasLinkedInMatch}`);
      
      progressUpdate?.(`验证完成，找到 ${validResults.length} 个结果，最佳匹配度: ${bestMatch.match_result.overall_score}/10`);
      
      // 包含回退情况的提示（如果有回退结果）
      const note = fallbackResults.length > 0 
        ? `部分结果(${fallbackResults.length}/${validResults.length})基于搜索信息而非完整页面内容` 
        : undefined;
      
      return {
        success: true,
        message: hasLinkedInMatch
          ? `找到${companyName}的官方LinkedIn页面`
          : `未找到${companyName}的可靠官方LinkedIn页面`,
        results: validResults,
        best_match: bestMatch,
        linkedin: hasLinkedInMatch,
        linkedin_url: hasLinkedInMatch ? bestMatch.url : null,
        note: note
      };
    } catch (error) {
      // 确保清理浏览器资源
      await WebCrawler.closeBrowser().catch(() => {});
      
      logToFile(`验证公司LinkedIn页面失败: ${error instanceof Error ? error.message : String(error)}`, true);
      if (error instanceof Error && error.stack) {
        logToFile(`错误堆栈: ${error.stack}`, true);
      }
      
      progressUpdate?.(`验证失败: ${error instanceof Error ? error.message : String(error)}`);
      
      return {
        success: false,
        message: `验证失败: ${error instanceof Error ? error.message : String(error)}`,
        results: [],
        linkedin: false,
        linkedin_url: null
      };
    }
  }
} 