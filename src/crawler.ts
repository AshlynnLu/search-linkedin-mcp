import * as playwright from 'playwright';
import * as cheerio from 'cheerio';
import { execSync } from 'child_process';
import * as fs from 'fs';
import { getParamValue, ENV_NAMES, getAuthValue } from './config/env.js';

// 简单日志辅助函数，输出到文件
const logToFile = (message: string, isError = false) => {
  try {
    // 日志消息添加时间戳
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    // 追加到日志文件
    fs.appendFileSync('crawler.log', logMessage);
  } catch {
    // 忽略日志错误
  }
};

/**
 * 信号量类，用于控制并发
 */
class Semaphore {
  private counter: number;
  private waiting: Array<() => void> = [];

  constructor(private max: number) {
    this.counter = max;
  }

  public async acquire(): Promise<void> {
    if (this.counter > 0) {
      this.counter--;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => this.waiting.push(resolve));
  }

  public release(): void {
    this.counter++;
    if (this.counter > 0 && this.waiting.length > 0) {
      this.counter--;
      const resolve = this.waiting.shift()!;
      resolve();
    }
  }
}

/**
 * 网页爬虫类，用于爬取网页内容
 */
export class WebCrawler {
  // 设置最大并发爬取请求数
  private static semaphore = new Semaphore(5);
  private static browserPromise: Promise<playwright.Browser> | null = null;
  private static browser: playwright.Browser | null = null;

  /**
   * 确保Playwright浏览器已安装
   */
  private static ensureBrowserInstalled() {
    try {
      logToFile('检查Playwright浏览器安装状态...');
      execSync('npx playwright install chromium --with-deps', { stdio: 'ignore' });
      logToFile('Playwright浏览器安装检查完成');
    } catch (error) {
      logToFile(`安装Playwright浏览器时出错: ${error}`, true);
    }
  }

  /**
   * 获取代理配置
   * 使用神龙代理，从环境变量或者请求中获取配置
   * @param request 可选的MCP请求对象
   */
  private static getProxy(request?: any) {
    // 获取代理服务器
    const serverFromRequest = request ? getAuthValue(request, ENV_NAMES.PROXY_SERVER) : null;
    const server = serverFromRequest || getParamValue(ENV_NAMES.PROXY_SERVER);
    
    // 获取代理用户名
    const usernameFromRequest = request ? getAuthValue(request, ENV_NAMES.PROXY_USERNAME) : null;
    const username = usernameFromRequest || getParamValue(ENV_NAMES.PROXY_USERNAME);
    
    // 获取代理密码
    const passwordFromRequest = request ? getAuthValue(request, ENV_NAMES.PROXY_PASSWORD) : null;
    const password = passwordFromRequest || getParamValue(ENV_NAMES.PROXY_PASSWORD);
    
    // 检查配置是否完整
    if (!server || !username || !password) {
      logToFile('代理配置不完整，将不使用代理', true);
      return null;
    }
    
    return {
      server,
      username,
      password
    };
  }

  /**
   * 获取共享浏览器实例，提高性能
   */
  private static async getBrowser(): Promise<playwright.Browser> {
    if (!this.browser) {
      // 首次创建浏览器实例时进行初始化
      this.ensureBrowserInstalled();
      
      if (!this.browserPromise) {
        logToFile('初始化浏览器...');
        this.browserPromise = playwright.chromium.launch({
          headless: true,
          args: ['--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
      }
      
      try {
        this.browser = await this.browserPromise;
        logToFile('浏览器启动成功');
      } catch (error) {
        logToFile(`浏览器启动失败: ${error}`, true);
        this.browserPromise = null;
        throw error;
      }
    }
    
    return this.browser;
  }

  /**
   * 并发爬取网页内容，使用信号量控制并发
   * @param url 要爬取的网页URL
   * @param retries 重试次数，默认为2
   * @param request 可选的MCP请求对象
   * @returns 返回网页内容文本
   */
  public static async crawlPage(url: string, retries = 2, request?: any): Promise<string> {
    // 获取信号量，控制并发
    await this.semaphore.acquire();
    
    logToFile(`开始爬取页面(剩余重试次数:${retries}): ${url}`);
    
    // 获取代理配置
    const proxy = this.getProxy(request);
    if (proxy) {
      logToFile(`使用代理: ${proxy.server}`);
    } else {
      logToFile('未配置代理，直接访问');
    }
    
    let context: playwright.BrowserContext | null = null;
    let page: playwright.Page | null = null;
    
    try {
      // 获取共享的浏览器实例
      const browser = await this.getBrowser();
      
      // 创建新的上下文，使用代理（如果有）
      const contextOptions: playwright.BrowserContextOptions = {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      };
      
      // 如果有代理，添加到选项中
      if (proxy) {
        contextOptions.proxy = proxy;
      }
      
      context = await browser.newContext(contextOptions);
      
      // 设置超时
      context.setDefaultTimeout(20000);
      
      page = await context.newPage();
      
      // 设置网络超时
      page.setDefaultNavigationTimeout(20000);
      page.setDefaultTimeout(20000);
      
      // 记录流量
      let totalBytes = 0;
      
      // 创建 CDP 会话监控流量
      const client = await context.newCDPSession(page);
      await client.send('Network.enable');
      client.on('Network.loadingFinished', event => {
        if ('encodedDataLength' in event) {
          totalBytes += (event as any).encodedDataLength;
        }
      });
      
      // 资源拦截：阻止加载图片、字体、样式表、音视频
      await page.route('**/*', async (route) => {
        try {
          const resourceType = route.request().resourceType();
          if (['image', 'font', 'stylesheet', 'media'].includes(resourceType)) {
            await route.abort();
          } else {
            await route.continue();
          }
        } catch (err) {
          try {
            await route.continue();
          } catch {
            // 忽略错误
          }
        }
      });
      
      const startTime = Date.now();
      
      // 使用Promise.race添加额外的超时控制
      const navigationPromise = page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('页面加载超时')), 25000);
      });
      
      await Promise.race([navigationPromise, timeoutPromise]);
      
      // 等待页面内容加载
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {
        logToFile('等待页面加载状态超时，继续处理', true);
      });
      
      // 获取页面内容
      const content = await page.content();
      
      const endTime = Date.now();
      logToFile(`页面加载完成，耗时: ${endTime - startTime}ms，数据传输: ${totalBytes / 1024}KB`);
      
      // 解析HTML内容提取文本
      return this.parseHtml(content);
    } catch (error) {
      logToFile(`爬取页面失败 ${url}: ${error instanceof Error ? error.message : String(error)}`, true);
      
      // 如果还有重试次数，则重试
      if (retries > 0) {
        logToFile(`尝试重新爬取页面: ${url}，剩余重试次数: ${retries - 1}`);
        // 释放信号量
        this.semaphore.release();
        return this.crawlPage(url, retries - 1, request);
      }
      
      return "";
    } finally {
      // 确保资源关闭
      try {
        if (page) await page.close();
        if (context) await context.close();
      } catch (error) {
        logToFile(`关闭浏览器资源时出错: ${error}`, true);
      }
      
      // 释放信号量
      this.semaphore.release();
    }
  }
  
  /**
   * 解析HTML内容提取文本
   * @param html HTML内容
   * @returns 提取的文本
   */
  private static parseHtml(html: string): string {
    try {
      const $ = cheerio.load(html);
      
      // 移除脚本和样式
      $('script, style').remove();
      
      // 获取文本内容
      let text = $('body').text();
      
      // 清理文本
      text = text.replace(/\s+/g, ' ').trim();
      
      return text;
    } catch (error) {
      logToFile(`解析HTML时出错: ${error}`, true);
      return "";
    }
  }
  
  /**
   * 批量并发爬取多个URL
   * @param urls 要爬取的URL列表
   * @returns 爬取结果，URL和内容的映射
   */
  public static async crawlMultiplePages(urls: string[]): Promise<Map<string, string>> {
    logToFile(`开始批量爬取 ${urls.length} 个页面`);
    
    const results = new Map<string, string>();
    const promises = urls.map(url => this.crawlPage(url).then(content => {
      results.set(url, content);
      return { url, content };
    }));
    
    await Promise.all(promises);
    logToFile(`批量爬取完成，成功爬取 ${results.size} 个页面`);
    
    return results;
  }
  
  /**
   * 关闭共享浏览器实例
   */
  public static async closeBrowser(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close();
        logToFile('关闭共享浏览器实例');
      } catch (error) {
        logToFile(`关闭浏览器时出错: ${error}`, true);
      } finally {
        this.browser = null;
        this.browserPromise = null;
      }
    }
  }
} 