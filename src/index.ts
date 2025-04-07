#!/usr/bin/env node

/**
 * 商机通 - 商机智能验证服务
 * 提供公司LinkedIn页面验证及信息提取功能，包括：
 * - 搜索公司LinkedIn页面
 * - 爬取LinkedIn页面内容
 * - 验证页面内容与公司匹配度
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { searchCompany } from "./google.js";
import { CompanyVerifier } from "./companyVerifier.js";
import fs from 'fs';
import { WebCrawler } from "./crawler.js";
import { verifyCompanyMatch } from "./llm.js";
import { getParamValue, ENV_NAMES } from "./config/env.js";

// 简单日志辅助函数，在开发时使用文件记录而不是控制台输出
const logger = {
  info: (message: string) => {
    // 开发时可切换为文件记录，或者完全禁用
    // 现在完全禁用控制台输出，避免干扰MCP协议
    // console.log(message);
    try {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] INFO: ${message}\n`;
      fs.appendFileSync('mcp-server.log', logMessage);
    } catch {
      // 忽略日志错误
    }
  },
  error: (message: string, error?: any) => {
    // 错误信息也禁用控制台输出
    // console.error(message, error);
    try {
      const timestamp = new Date().toISOString();
      const errorDetails = error ? `: ${error instanceof Error ? error.message : String(error)}` : '';
      const logMessage = `[${timestamp}] ERROR: ${message}${errorDetails}\n`;
      fs.appendFileSync('mcp-server.log', logMessage);
    } catch {
      // 忽略日志错误
    }
  }
};

/**
 * Create an MCP server with tools capabilities.
 */
const server = new Server(
  {
    name: "shangjitong",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    }
  }
);

/**
 * Handler that lists available tools.
 * Exposes tools for company verification and information extraction.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  // 获取API密钥配置状态
  const serperApiKey = getParamValue(ENV_NAMES.SERPER_API_KEY);
  const openaiApiKey = getParamValue(ENV_NAMES.OPENAI_API_KEY);
  const proxyConfigured = getParamValue(ENV_NAMES.PROXY_SERVER) && 
                          getParamValue(ENV_NAMES.PROXY_USERNAME) && 
                          getParamValue(ENV_NAMES.PROXY_PASSWORD);
  
  // 未配置API密钥时的提示信息
  const searchWarning = !serperApiKey ? "（请先配置SHANGJI_SERPER_DEV_WEB_SEARCH_KEY环境变量）" : "";
  const verifyWarning = !openaiApiKey ? "（请先配置OPENAI_API_KEY环境变量）" : "";
  const crawlWarning = !proxyConfigured ? "（推荐配置代理环境变量以获得更稳定结果）" : "";

  return {
    tools: [
      {
        name: "search_company",
        description: `搜索公司信息（使用Google搜索）${searchWarning}`,
        inputSchema: {
          type: "object",
          properties: {
            company_name: {
              type: "string",
              description: "公司名称"
            }
          },
          required: ["company_name"]
        }
      },
      {
        name: "crawl_multiple_pages",
        description: `并行爬取多个LinkedIn页面内容${crawlWarning}`,
        inputSchema: {
          type: "object",
          properties: {
            urls: {
              type: "array",
              items: {
                type: "string"
              },
              description: "要并行爬取的URL列表"
            }
          },
          required: ["urls"]
        }
      },
      {
        name: "verify_multiple_contents",
        description: `批量验证多个页面内容是否匹配指定公司（适合验证爬虫批量结果）${verifyWarning}`,
        inputSchema: {
          type: "object",
          properties: {
            company_name: {
              type: "string",
              description: "公司名称"
            },
            pages: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  url: {
                    type: "string",
                    description: "页面URL"
                  },
                  content: {
                    type: "string",
                    description: "页面内容"
                  }
                }
              },
              description: "要验证的页面列表，每项包含URL和内容"
            },
            official_website: {
              type: "string",
              description: "公司官方网站URL（可选）"
            }
          },
          required: ["company_name", "pages"]
        }
      },
      {
        name: "verify_company",
        description: `验证公司LinkedIn页面（完整流程，需配置所有环境变量）${!serperApiKey || !openaiApiKey || !proxyConfigured ? "（请先完成所有环境变量配置）" : ""}`,
        inputSchema: {
          type: "object",
          properties: {
            company_name: {
              type: "string",
              description: "公司名称"
            },
            official_website: {
              type: "string",
              description: "公司官方网站URL（可选）"
            }
          },
          required: ["company_name"]
        }
      }
    ]
  };
});

/**
 * Handler for tool calls.
 * Processes tools like search_company, crawl_company and verify_company_content
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case "search_company": {
      const companyName = String(request.params.arguments?.company_name);
      
      if (!companyName) {
        throw new Error("公司名称是必需的");
      }

      try {
        const results = await searchCompany(companyName, request);
        
        // 返回JSON格式结果
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              results: results.map(result => ({
                title: result.title || 'No title',
                url: result.link,
                snippet: result.snippet || 'No snippet'
              })),
              count: results.length
            })
          }]
        };
      } catch (error) {
        logger.error("搜索公司信息失败", error);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: `搜索公司"${companyName}"失败: ${error instanceof Error ? error.message : String(error)}`,
              results: [],
              count: 0
            })
          }]
        };
      }
    }
    
    case "crawl_multiple_pages": {
      const urls = request.params.arguments?.urls as string[] | undefined;
      
      if (!urls || !Array.isArray(urls) || urls.length === 0) {
        throw new Error("URL列表是必需的，且不能为空");
      }

      try {
        // 修改爬取函数，添加请求参数
        const promises = urls.map(url => WebCrawler.crawlPage(url, 2, request));
        const pageContents = await Promise.all(promises);
        
        // 处理爬取结果，创建URL和内容的映射
        const resultsMap = new Map<string, string>();
        urls.forEach((url, index) => {
          const content = pageContents[index];
          if (content) {
            resultsMap.set(url, content);
          }
        });
        
        if (resultsMap.size === 0) {
          // 所有爬取都失败
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: false,
                urls: urls,
                error: "所有页面爬取失败",
                results: []
              })
            }]
          };
        }
        
        // 处理爬取结果
        const results = urls.map(url => {
          const content = resultsMap.get(url);
          if (!content) {
            return {
              url,
              success: false,
              error: "爬取失败或内容为空",
              content: ""
            };
          }
          
          // 限制内容长度
          const truncatedContent = content.length > 5000 
            ? content.substring(0, 5000) + "..." 
            : content;
          
          return {
            url,
            success: true,
            content: truncatedContent
          };
        });
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              total: urls.length,
              success_count: resultsMap.size,
              results: results
            })
          }]
        };
      } catch (error) {
        logger.error(`批量爬取页面失败`, error);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              urls: urls,
              error: `批量爬取失败: ${error instanceof Error ? error.message : String(error)}`,
              results: []
            })
          }]
        };
      }
    }
    
    case "verify_multiple_contents": {
      const companyName = String(request.params.arguments?.company_name);
      const pages = request.params.arguments?.pages as Array<{url: string, content: string}> | undefined;
      const officialWebsite = request.params.arguments?.official_website as string | undefined;
      
      if (!companyName || !pages || !Array.isArray(pages) || pages.length === 0) {
        throw new Error("公司名称和页面列表是必需的，且列表不能为空");
      }

      try {
        // 并行验证所有页面内容
        const verificationPromises = pages.map(async (page) => {
          try {
            const { url, content } = page;
            if (!url || !content) {
              return {
                url: url || 'unknown',
                success: false,
                error: "URL或内容为空",
                is_match: false
              };
            }
            
            // 使用LLM验证页面内容
            const result = await verifyCompanyMatch(
              companyName,
              content,
              {
                title: url,     // 使用URL作为标题
                snippet: ''     // 空摘要
              },
              officialWebsite,
              request  // 传递请求对象
            );
            
            return {
              url,
              success: true,
              is_match: result.is_match,
              match_score: result.overall_score,
              details: {
                name_score: result.name_score,
                business_score: result.business_score,
                credibility_score: result.credibility_score,
                website_score: result.website_score || 0
              }
            };
          } catch (error) {
            return {
              url: page.url || 'unknown',
              success: false,
              error: `验证失败: ${error instanceof Error ? error.message : String(error)}`,
              is_match: false
            };
          }
        });
        
        // 等待所有验证完成
        const results = await Promise.all(verificationPromises);
        
        // 找出最佳匹配
        const matchingResults = results.filter(r => r.success && r.is_match);
        let bestMatch = null;
        
        if (matchingResults.length > 0) {
          // 按匹配分数排序
          matchingResults.sort((a, b) => (b.match_score || 0) - (a.match_score || 0));
          bestMatch = matchingResults[0];
        }
        
        // 返回验证结果
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              company_name: companyName,
              total: pages.length,
              match_count: matchingResults.length,
              linkedin: matchingResults.length > 0,
              linkedin_url: bestMatch ? bestMatch.url : null,
              best_match: bestMatch,
              results: results
            })
          }]
        };
      } catch (error) {
        logger.error("批量验证页面内容失败", error);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              company_name: companyName,
              error: `批量验证失败: ${error instanceof Error ? error.message : String(error)}`,
              linkedin: false,
              linkedin_url: null,
              results: []
            })
          }]
        };
      }
    }

    case "verify_company": {
      const companyName = String(request.params.arguments?.company_name);
      const officialWebsite = request.params.arguments?.official_website as string | undefined;
      
      if (!companyName) {
        throw new Error("公司名称是必需的");
      }

      try {
        // 使用CompanyVerifier验证LinkedIn页面
        const result = await CompanyVerifier.verifyCompanyLinkedIn(companyName, officialWebsite);
        
        if (!result.success) {
          // 返回简化的JSON格式错误信息
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                linkedin: false,
                linkedin_url: null
              })
            }]
          };
        }
        
        // 返回简化的JSON格式结果，只包含linkedin和linkedin_url
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              linkedin: result.linkedin,
              linkedin_url: result.linkedin_url
            })
          }]
        };
      } catch (error) {
        logger.error("验证公司信息失败", error);
        
        // 返回简化的JSON格式错误信息
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              linkedin: false,
              linkedin_url: null
            })
          }]
        };
      }
    }

    default:
      throw new Error("Unknown tool");
  }
});

/**
 * Start the server using stdio transport.
 * This allows the server to communicate via standard input/output streams.
 */
async function main() {
  // 校验必要的环境变量是否配置
  const serperApiKey = getParamValue(ENV_NAMES.SERPER_API_KEY);
  const openaiApiKey = getParamValue(ENV_NAMES.OPENAI_API_KEY);
  const proxyServer = getParamValue(ENV_NAMES.PROXY_SERVER);
  const proxyUsername = getParamValue(ENV_NAMES.PROXY_USERNAME);
  const proxyPassword = getParamValue(ENV_NAMES.PROXY_PASSWORD);

  // 检查API密钥
  if (!serperApiKey) {
    logger.error("未配置Google搜索API密钥(SHANGJI_SERPER_DEV_WEB_SEARCH_KEY)，部分功能将不可用");
  }
  
  if (!openaiApiKey) {
    logger.error("未配置OpenAI API密钥(OPENAI_API_KEY)，验证功能可能受限");
  }
  
  // 检查代理配置
  if (!proxyServer || !proxyUsername || !proxyPassword) {
    logger.error("未完整配置代理服务器信息(PROXY_SERVER/PROXY_USERNAME/PROXY_PASSWORD)，网络访问可能受限");
  }
  
  // 启动日志信息
  logger.info(`启动MCP服务器 shangjitong v0.1.0`);
  if (serperApiKey) logger.info("已配置Google搜索API");
  if (openaiApiKey) logger.info("已配置OpenAI API");
  if (proxyServer && proxyUsername && proxyPassword) logger.info("已配置代理服务器");
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  logger.error("Server error", error);
  process.exit(1);
});
