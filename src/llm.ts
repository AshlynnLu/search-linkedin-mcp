import fetch from 'cross-fetch';
import * as fs from 'fs';
import { getParamValue, ENV_NAMES, getAuthValue } from './config/env.js';

// 简单日志辅助函数，输出到文件
const logToFile = (message: string, isError = false) => {
  try {
    // 日志消息添加时间戳
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    // 追加到日志文件
    fs.appendFileSync('llm.log', logMessage);
  } catch {
    // 忽略日志错误
  }
};

/**
 * 大模型服务封装，使用OpenAI API进行验证
 */

// 获取API密钥
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const BASE_URL = 'http://test.2brain.cn:22434/v1';

interface MatchResult {
  name_score: number;
  business_score: number;
  credibility_score: number;
  website_score: number;
  website_found: string;
  overall_score: number;
  analysis: string;
  is_match: boolean;
}

/**
 * 使用大模型验证网页内容是否与查询的公司匹配
 * @param companyName 公司名称
 * @param pageContent 网页内容
 * @param pageInfo 网页信息（标题、摘要等）
 * @param officialWebsite 官方网站URL（可选）
 * @param request 可选的MCP请求对象（用于获取API密钥）
 * @returns 验证结果
 */
export async function verifyCompanyMatch(
  companyName: string, 
  pageContent: string, 
  pageInfo: { title?: string, snippet?: string },
  officialWebsite?: string,
  request?: any
): Promise<MatchResult> {
  // 截取内容以避免token过长
  const trimmedContent = pageContent.length > 3000 ? pageContent.substring(0, 3000) : pageContent;
  
  try {
    // 优先使用OpenAI API，不再检查API密钥是否存在
    logToFile("使用OpenAI API进行验证");

    // 构建提示词
    const websitePrompt = officialWebsite 
      ? `4. 官方网站匹配 (0-10分): 网页中是否包含或提及公司官方网站"${officialWebsite}"。如果完全匹配则为10分，模糊匹配（如只包含域名的一部分）则为5分，没有匹配为0分。`
      : `4. 官方网站信息 (0-10分): 网页中是否包含公司官方网站的链接或文本信息。有完整网址为10分，有部分网址或域名为5分，无信息为0分。`;
    
    const prompt = `
请分析以下网页内容，判断它是否是"${companyName}"公司的LinkedIn页面。
网页标题: ${pageInfo.title || '未知'}
网页摘要: ${pageInfo.snippet || '未知'}

网页内容:
${trimmedContent}

请根据以下标准给出评分和分析:
1. 公司名称匹配度 (0-10分): 网页中是否明确提到了"${companyName}"或相似名称
2. 业务相关性 (0-10分): 网页内容是否描述了与"${companyName}"相关的业务
3. 网页可信度 (0-10分): 网页是否来自官方渠道或可信来源
${websitePrompt}

最后，综合以上因素，给出总体匹配度评分 (0-10分)，并给出简短分析。

请以JSON格式返回结果:
{
  "name_score": 评分,
  "business_score": 评分,
  "credibility_score": 评分,
  "website_score": 评分,
  "website_found": "发现的网站URL" 或 "",
  "overall_score": 评分,
  "analysis": "简短分析",
  "is_match": true/false (总分≥7为true，否则为false)
}
`;

    // 尝试调用OpenAI API
    try {
      // 获取OpenAI API密钥，优先使用请求中的认证信息
      const apiKey = request ? getAuthValue(request, ENV_NAMES.OPENAI_API_KEY) : null;
      const openaiApiKey = apiKey || getParamValue(ENV_NAMES.OPENAI_API_KEY);
      
      if (!openaiApiKey) {
        throw new Error('OpenAI API密钥未设置');
      }
      
      // 使用OpenAI的API
      logToFile("正在调用OpenAI API...");
      const response = await fetch(OPENAI_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiApiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o',  // 使用最新的GPT-4o模型
          messages: [
            {
              role: 'system',
              content: '你是一个专业的网页内容分析专家，擅长判断网页内容与特定公司的相关性和官方信息。'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          response_format: { type: 'json_object' }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        logToFile(`OpenAI API调用失败: ${response.status} ${response.statusText} - ${errorText}`, true);
        throw new Error(`API调用失败: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const responseText = data.choices[0].message.content;
      logToFile(`获取到OpenAI响应: ${responseText}`);

      // 尝试解析JSON响应
      try {
        const result = JSON.parse(responseText);
        logToFile(`AI分析结果: ${JSON.stringify(result)}`);
        return result;
      } catch (error) {
        logToFile(`解析OpenAI返回的JSON失败: ${error}`, true);
        // 尝试提取JSON部分
        const jsonMatch = responseText.match(/({.*})/s);
        if (jsonMatch) {
          try {
            return JSON.parse(jsonMatch[0]);
          } catch {
            // 解析失败，尝试使用备用模型
            throw new Error("无法解析OpenAI响应");
          }
        }
        throw new Error("无法解析OpenAI响应");
      }
    } catch (error) {
      logToFile(`调用OpenAI API失败: ${error}`, true);
      
      // 如果OpenAI API失败，尝试使用本地部署的大模型API
      try {
        // 获取本地API密钥
        const localApiKey = request ? getAuthValue(request, ENV_NAMES.LOCAL_API_KEY) : null;
        const apiKey = localApiKey || getParamValue(ENV_NAMES.LOCAL_API_KEY);
        
        if (!apiKey) {
          throw new Error('本地API密钥未设置');
        }
        
        logToFile("尝试使用本地部署的大模型API...");
        const response = await fetch(`${BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: 'gemma3:27b-it-fp16',
            messages: [
              {
                role: 'system',
                content: '你是一个专业的网页内容分析专家，擅长判断网页内容与特定公司的相关性和官方信息。'
              },
              {
                role: 'user',
                content: prompt
              }
            ],
            response_format: { type: 'json_object' }
          })
        });

        if (!response.ok) {
          throw new Error(`本地API调用失败: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        const responseText = data.choices[0].message.content;
        logToFile(`获取到本地模型响应: ${responseText}`);
        return JSON.parse(responseText);
      } catch (localError) {
        logToFile(`本地API调用也失败: ${localError}`, true);
        // 都失败的情况下，使用回退验证
        logToFile("所有API调用都失败，使用回退验证", true);
        return fallbackVerification(companyName, pageContent, pageInfo, officialWebsite);
      }
    }
  } catch (error) {
    logToFile(`验证过程出错: ${error}`, true);
    // 出错时返回默认验证结果
    return fallbackVerification(companyName, pageContent, pageInfo, officialWebsite);
  }
}

/**
 * 基于规则的回退验证方法
 */
function fallbackVerification(
  companyName: string, 
  pageContent: string, 
  pageInfo: { title?: string, snippet?: string },
  officialWebsite?: string
): MatchResult {
  logToFile("使用回退验证方法");
  // 根据网页内容评估匹配度
  const nameMatch = pageContent.toLowerCase().includes(companyName.toLowerCase());
  const nameScore = nameMatch ? 8 : 3;
  
  // 基于简单规则的评分
  const credibilityScore = pageInfo.title?.includes('LinkedIn') ? 9 : 5;
  
  // 网站匹配度
  let websiteScore = 5;
  let websiteFound = '';
  
  if (officialWebsite) {
    // 从网址中提取域名部分
    const domain = officialWebsite.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (pageContent.includes(domain)) {
      websiteScore = 10;
      websiteFound = officialWebsite;
    }
  }
  
  // 计算总体分数
  const overallScore = Math.round((nameScore + 7 + credibilityScore + websiteScore) / 4);
  
  return {
    name_score: nameScore,
    business_score: 7, // 默认业务相关性中等偏上
    credibility_score: credibilityScore,
    website_score: websiteScore,
    website_found: websiteFound,
    overall_score: overallScore,
    analysis: `这${overallScore >= 7 ? '很可能' : '可能不'}是${companyName}的官方LinkedIn页面。${
      nameMatch ? `页面内容中提到了${companyName}。` : `页面内容中未明确提到${companyName}。`
    }${
      websiteFound ? `在页面中发现了公司网站信息: ${websiteFound}` : '未在页面中找到明确的公司网站信息。'
    }`,
    is_match: overallScore >= 7
  };
} 