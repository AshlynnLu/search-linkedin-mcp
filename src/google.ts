import fetch from 'cross-fetch';
import { getParamValue, ENV_NAMES, getAuthValue } from './config/env.js';
import * as fs from 'fs';

// 简单日志辅助函数，输出到文件
const logToFile = (message: string, isError = false) => {
  try {
    // 日志消息添加时间戳
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    // 追加到日志文件
    fs.appendFileSync('google.log', logMessage);
  } catch {
    // 忽略日志错误
  }
};

interface SearchResult {
  link: string;
  title?: string;
  snippet?: string;
}

interface SerperResponse {
  organic?: Array<{
    link: string;
    title?: string;
    snippet?: string;
  }>;
}

/**
 * Performs a Google search using the Serper.dev API
 * @param query Search query string
 * @param site Optional site restriction (e.g. 'linkedin.com')
 * @param numResults Number of results to return (default: 3)
 * @returns Search results from Serper API
 */
export async function serperDevSearch(query: string, site?: string, numResults: number = 3, request?: any): Promise<SerperResponse> {
  const url = "https://google.serper.dev/search";
  
  // 调整为只搜索LinkedIn页面
  // 如果提供了特定网站，则使用该网站；否则默认使用linkedin.com
  const siteRestriction = site || 'linkedin.com/company';
  const fullQuery = `${query} site:${siteRestriction}`;
  
  logToFile(`执行搜索: ${fullQuery}`);

  const payload = JSON.stringify({
    q: fullQuery,
    num: numResults
  });

  // 直接从环境变量读取API密钥
  const serperApiKey = process.env.SHANGJI_SERPER_DEV_WEB_SEARCH_KEY;
  
  if (!serperApiKey) {
    throw new Error('Google搜索API密钥未设置');
  }

  const headers = {
    'X-API-KEY': serperApiKey,
    'Content-Type': 'application/json'
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: payload
    });

    if (!response.ok) {
      throw new Error(`Serper API error: ${response.status} ${response.statusText}`);
    }

    return await response.json() as SerperResponse;
  } catch (error) {
    logToFile(`Error fetching search results: ${error}`, true);
    throw error;
  }
}

/**
 * Extracts relevant URLs from search results
 * @param searchResults Search results from Serper API
 * @returns Array of URLs with metadata
 */
export function extractUrls(searchResults: SerperResponse): SearchResult[] {
  const urls: SearchResult[] = [];
  
  if (searchResults.organic) {
    for (const result of searchResults.organic) {
      if (result.link) {
        urls.push({
          link: result.link,
          title: result.title || '',
          snippet: result.snippet || ''
        });
      }
    }
  }
  
  return urls;
}

/**
 * Search for company information
 * @param companyName Name of the company to search for
 * @param request Optional MCP request object for auth
 * @returns Array of search results
 */
export async function searchCompany(companyName: string, request?: any): Promise<SearchResult[]> {
  // 搜索LinkedIn公司页面，不再需要额外的site参数
  const searchResults = await serperDevSearch(companyName, undefined, 3, request);
  return extractUrls(searchResults);
} 