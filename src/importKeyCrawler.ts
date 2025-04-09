import * as playwright from 'playwright';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import { getParamValue, ENV_NAMES, getAuthValue } from './config/env.js';

// 简单日志辅助函数，输出到文件
const logToFile = (message: string, isError = false) => {
  try {
    // 检查消息长度，如果超过500个字符，截断它
    let logMessage = message;
    if (logMessage.length > 500) {
      logMessage = logMessage.substring(0, 500) + `... [截断，完整长度: ${message.length}字符]`;
    }
    
    // 日志消息添加时间戳
    const timestamp = new Date().toISOString();
    const finalLogMessage = `[${timestamp}] ${isError ? '[ERROR] ' : ''}${logMessage}\n`;
    
    // 追加到日志文件
    fs.appendFileSync('importkey-crawler.log', finalLogMessage);
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
 * ImportKey爬虫类，用于爬取ImportKey网站的数据
 */
export class ImportKeyCrawler {
  // 设置最大并发爬取请求数
  private static semaphore = new Semaphore(2);
  private static browserPromise: Promise<playwright.Browser> | null = null;
  private static browser: playwright.Browser | null = null;
  private static context: playwright.BrowserContext | null = null;
  private static isLoggedIn = false;

  // 登录凭证
  private static email: string;
  private static password: string;

  /**
   * 清理日志文件，避免过大
   */
  private static cleanupLogFile() {
    try {
      const logFile = 'importkey-crawler.log';
      // 检查日志文件是否存在
      if (fs.existsSync(logFile)) {
        // 获取文件状态
        const stats = fs.statSync(logFile);
        // 如果超过5MB，备份并创建新文件
        const maxSize = 5 * 1024 * 1024; // 5MB
        if (stats.size > maxSize) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const backupFile = `importkey-crawler-${timestamp}.log`;
          fs.renameSync(logFile, backupFile);
          logToFile(`日志文件已超过5MB，已备份到 ${backupFile}`);
        }
      }
    } catch (error) {
      // 忽略错误，不影响主流程
      console.error(`清理日志文件时出错: ${error}`);
    }
  }

  /**
   * 初始化爬虫并设置登录凭证
   * @param email ImportKey登录邮箱
   * @param password ImportKey登录密码
   */
  public static init(email: string, password: string): void {
    this.email = email;
    this.password = password;
    this.isLoggedIn = false;
    // 先清理日志文件，避免过大
    this.cleanupLogFile();
    logToFile('ImportKey爬虫初始化完成');
  }

  /**
   * 确保Playwright浏览器已安装
   */
  private static ensureBrowserInstalled() {
    try {
      logToFile('检查Playwright浏览器安装状态...');
      // 这里可以使用execSync检查是否已安装，但为了简化，我们假设已经安装
      logToFile('Playwright浏览器安装检查完成');
    } catch (error) {
      logToFile(`安装Playwright浏览器时出错: ${error}`, true);
    }
  }

  /**
   * 获取代理配置
   */
  private static getProxy() {
    // 获取代理服务器
    const server = getParamValue(ENV_NAMES.PROXY_SERVER);
    
    // 获取代理用户名
    const username = getParamValue(ENV_NAMES.PROXY_USERNAME);
    
    // 获取代理密码
    const password = getParamValue(ENV_NAMES.PROXY_PASSWORD);
    
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
   * 创建浏览器上下文并处理登录
   */
  private static async getContext(): Promise<playwright.BrowserContext> {
    if (!this.context) {
      const browser = await this.getBrowser();
      
      // 创建新的上下文，使用代理（如果有）
      const contextOptions: playwright.BrowserContextOptions = {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      };
      
      // 如果有代理，添加到选项中
      const proxy = this.getProxy();
      if (proxy) {
        contextOptions.proxy = proxy;
        logToFile(`使用代理: ${proxy.server}`);
      }
      
      this.context = await browser.newContext(contextOptions);
      
      // 设置超时
      this.context.setDefaultTimeout(60000);
      
      // 登录
      await this.login();
    } else if (!this.isLoggedIn) {
      // 如果有上下文但未登录，尝试登录
      await this.login();
    }
    
    return this.context;
  }

  /**
   * 登录ImportKey网站
   */
  private static async login(): Promise<void> {
    if (this.isLoggedIn) {
      logToFile('已经登录，无需重复登录');
      return;
    }

    if (!this.context) {
      throw new Error('浏览器上下文未初始化');
    }

    if (!this.email || !this.password) {
      throw new Error('登录凭证未设置');
    }

    logToFile('开始登录ImportKey...');
    
    const page = await this.context.newPage();
    
    try {
      // 增加超时时间
      page.setDefaultNavigationTimeout(120000); // 增加到120秒
      page.setDefaultTimeout(120000); // 增加到120秒
      
      // 访问登录页面
      await page.goto('https://importkey.com/login', { waitUntil: 'domcontentloaded' });
      logToFile('已加载登录页面');
      
      // 检查是否遇到Cloudflare保护
      const title = await page.title();
      if (title.includes('Attention Required') || title.includes('Cloudflare')) {
        logToFile(`检测到Cloudflare保护页面，终止爬虫`, true);
        // 立即抛出错误，不尝试解决
        throw new Error('检测到Cloudflare保护，终止爬虫');
      }
      
      // 等待页面稳定
      await page.waitForTimeout(3000);
      
      // 根据截图分析，添加针对ImportKey的特定选择器
      // 用户名输入框
      await page.waitForSelector('input[placeholder="Enter Email"]').catch(() => null);
      
      // 输入登录信息
      await page.fill('input[placeholder="Enter Email"]', this.email)
            .catch(() => logToFile('无法填写邮箱，尝试其他选择器', true));
      
      // 密码输入框
      await page.waitForSelector('input[placeholder="Enter Password"]').catch(() => null);
      
      await page.fill('input[placeholder="Enter Password"]', this.password)
            .catch(() => logToFile('无法填写密码，尝试其他选择器', true));
      
      // 尝试查找登录按钮
      const loginButton = await page.$('button.login, button:has-text("Login"), .login-btn');
      
      if (!loginButton) {
        // 如果找不到按钮，尝试使用回车键提交表单
        logToFile('未找到登录按钮，尝试使用回车键提交');
        await page.press('input[placeholder="Enter Password"]', 'Enter');
      } else {
        logToFile('找到登录按钮，点击登录');
        await loginButton.click();
      }
      
      // 等待登录完成
      await page.waitForTimeout(5000);
      
      // 页面跳转验证
      const currentUrl = page.url();
      logToFile(`登录后的URL: ${currentUrl}`);
      
      // 尝试访问dashboard验证登录状态
      try {
        await page.goto('https://importkey.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        // 检查是否成功进入dashboard
        const pageTitle = await page.title();
        
        if (pageTitle.includes('Dashboard') || pageTitle.includes('ImportKey')) {
          logToFile('成功进入dashboard，登录成功');
          this.isLoggedIn = true;
        } else {
          // 检查是否有登录提示
          const hasLoginPrompt = await page.$$eval('*', elements => {
            return elements.some(el => {
              const text = el.textContent || '';
              return text.includes('login') || text.includes('Login') || text.includes('sign in');
            });
          });
          
          if (hasLoginPrompt) {
            logToFile('无法访问dashboard，登录失败', true);
            throw new Error('登录失败');
          } else {
            logToFile('登录状态不明确，假定登录成功');
            this.isLoggedIn = true;
          }
        }
      } catch (error) {
        logToFile(`访问dashboard时出错: ${error}`, true);
        // 如果访问dashboard出错，但不一定是因为登录失败
        // 尝试直接进行数据访问
        this.isLoggedIn = true;
        logToFile('假定登录成功，后续操作将验证');
      }
      
    } catch (error) {
      logToFile(`登录过程中出错: ${error}`, true);
      throw error;
    } finally {
      await page.close();
    }
  }

  /**
   * 爬取公司买家数据
   * @param companyName 公司名称
   * @returns 买家数据
   */
  public static async crawlBuyerData(companyName: string): Promise<any> {
    // 确保已登录
    const context = await this.getContext();
    
    // 使用同一个页面实例，保持会话状态
    const page = await context.newPage();
    
    try {
      // 首先访问dashboard确认登录状态
      logToFile(`访问dashboard确认会话状态...`);
      await page.goto('https://importkey.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
      
      // 检查是否遇到Cloudflare保护
      const dashboardTitle = await page.title();
      if (dashboardTitle.includes('Attention Required') || dashboardTitle.includes('Cloudflare')) {
        logToFile(`检测到Cloudflare保护页面，终止爬虫`, true);
        throw new Error('检测到Cloudflare保护，终止爬虫');
      }
      
      // 检查是否仍然登录
      const currentUrl = page.url();
      if (currentUrl.includes('/login')) {
        logToFile(`会话已失效，需要重新登录`);
        this.isLoggedIn = false;
        
        // 关闭旧的context，重新创建
        if (this.context) {
          await this.context.close();
          this.context = null;
        }
        
        // 获取新的context并重新登录
        const newContext = await this.getContext();
        await page.close();
        return this.crawlBuyerData(companyName);
      }
      
      // 对公司名称进行URL编码
      const encodedName = encodeURIComponent(companyName);
      const url = `https://importkey.com/result/buyer/${encodedName}?domain=global`;
      
      logToFile(`会话有效，正在导航到: ${url}`);
      
      // 设置超时
      page.setDefaultNavigationTimeout(120000);
      page.setDefaultTimeout(120000);
      
      // 访问页面
      await page.goto(url, { waitUntil: 'networkidle', timeout: 120000 });
      
      // 等待页面加载
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(5000);
      
      // 检查是否遇到Cloudflare保护
      const resultPageTitle = await page.title();
      if (resultPageTitle.includes('Attention Required') || resultPageTitle.includes('Cloudflare')) {
        logToFile(`导航到买家页面时遇到Cloudflare保护，终止爬虫`, true);
        throw new Error('检测到Cloudflare保护，终止爬虫');
      }
      
      // 获取页面数据
      const pageData = await this.extractImportKeyData(page);
      
      logToFile(`买家页面爬取完成: ${url}`);
      return pageData;
    } catch (error) {
      logToFile(`爬取买家页面失败 ${companyName}: ${error instanceof Error ? error.message : String(error)}`, true);
      
      // 如果页面还存在，尝试获取一些基本信息
      try {
        const title = await page.title();
        const url = page.url();
        return {
          title,
          url,
          error: `爬取失败: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: new Date().toISOString()
        };
      } catch (e) {
        logToFile(`尝试获取失败页面的基本信息时出错: ${e}`, true);
        return null;
      }
    } finally {
      await page.close();
    }
  }

  /**
   * 爬取公司供应商数据
   * @param companyName 公司名称
   * @returns 供应商数据
   */
  public static async crawlSupplierData(companyName: string): Promise<any> {
    // 确保已登录
    const context = await this.getContext();
    
    // 使用同一个页面实例，保持会话状态
    const page = await context.newPage();
    
    try {
      // 首先访问dashboard确认登录状态
      logToFile(`访问dashboard确认会话状态...`);
      await page.goto('https://importkey.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
      
      // 检查是否遇到Cloudflare保护
      const dashboardTitle = await page.title();
      if (dashboardTitle.includes('Attention Required') || dashboardTitle.includes('Cloudflare')) {
        logToFile(`检测到Cloudflare保护页面，终止爬虫`, true);
        throw new Error('检测到Cloudflare保护，终止爬虫');
      }
      
      // 检查是否仍然登录
      const currentUrl = page.url();
      if (currentUrl.includes('/login')) {
        logToFile(`会话已失效，需要重新登录`);
        this.isLoggedIn = false;
        
        // 关闭旧的context，重新创建
        if (this.context) {
          await this.context.close();
          this.context = null;
        }
        
        // 获取新的context并重新登录
        const newContext = await this.getContext();
        await page.close();
        return this.crawlSupplierData(companyName);
      }
      
      // 对公司名称进行URL编码
      const encodedName = encodeURIComponent(companyName);
      const url = `https://importkey.com/result/supplier/${encodedName}?domain=global`;
      
      logToFile(`会话有效，正在导航到: ${url}`);
      
      // 设置超时
      page.setDefaultNavigationTimeout(120000);
      page.setDefaultTimeout(120000);
      
      // 访问页面
      await page.goto(url, { waitUntil: 'networkidle', timeout: 120000 });
      
      // 等待页面加载
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(5000);
      
      // 检查是否遇到Cloudflare保护
      const supplierPageTitle = await page.title();
      if (supplierPageTitle.includes('Attention Required') || supplierPageTitle.includes('Cloudflare')) {
        logToFile(`导航到供应商页面时遇到Cloudflare保护，终止爬虫`, true);
        throw new Error('检测到Cloudflare保护，终止爬虫');
      }
      
      // 获取页面数据
      const pageData = await this.extractImportKeyData(page);
      
      logToFile(`供应商页面爬取完成: ${url}`);
      return pageData;
    } catch (error) {
      logToFile(`爬取供应商页面失败 ${companyName}: ${error instanceof Error ? error.message : String(error)}`, true);
      
      // 如果页面还存在，尝试获取一些基本信息
      try {
        const title = await page.title();
        const url = page.url();
        return {
          title,
          url,
          error: `爬取失败: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: new Date().toISOString()
        };
      } catch (e) {
        logToFile(`尝试获取失败页面的基本信息时出错: ${e}`, true);
        return null;
      }
    } finally {
      await page.close();
    }
  }

  /**
   * 爬取页面数据
   * @param url 要爬取的URL
   * @returns 页面数据
   */
  private static async crawlPage(url: string): Promise<any> {
    await this.semaphore.acquire();
    
    logToFile(`开始爬取页面: ${url}`);
    
    const context = await this.getContext();
    let page: playwright.Page | null = null;
    
    try {
      page = await context.newPage();
      
      // 设置超时
      page.setDefaultNavigationTimeout(120000); // 增加到120秒
      page.setDefaultTimeout(120000); // 增加到120秒
      
      // 访问页面
      logToFile(`正在导航到URL: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
      logToFile(`页面导航完成: ${url}`);
      
      // 等待页面加载
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
        logToFile(`页面内容加载完成: ${url}`);
      } catch (error) {
        logToFile(`等待页面加载状态超时，继续处理: ${error}`, true);
      }
      
      // 去掉截图功能
      
      // 等待动态内容加载完成，从浏览器截图看页面加载中会有一定延迟
      await page.waitForTimeout(8000);
      
      // 获取页面数据
      const pageData = await this.extractImportKeyData(page);
      
      logToFile(`页面爬取完成: ${url}`);
      return pageData;
      
    } catch (error) {
      logToFile(`爬取页面失败 ${url}: ${error instanceof Error ? error.message : String(error)}`, true);
      
      // 如果页面还存在，尝试获取一些基本信息
      if (page) {
        try {
          const title = await page.title();
          const url = page.url();
          return {
            title,
            url,
            error: `爬取失败: ${error instanceof Error ? error.message : String(error)}`,
            timestamp: new Date().toISOString()
          };
        } catch (e) {
          logToFile(`尝试获取失败页面的基本信息时出错: ${e}`, true);
        }
      }
      
      return null;
    } finally {
      if (page) await page.close();
      this.semaphore.release();
    }
  }

  /**
   * 专门针对ImportKey网站提取数据
   * 根据网站截图分析页面结构
   * @param page Playwright页面对象
   * @returns 提取的数据
   */
  private static async extractImportKeyData(page: playwright.Page): Promise<any> {
    try {
      const title = await page.title();
      const currentUrl = page.url();
      
      logToFile(`提取ImportKey数据 - 页面标题: ${title}, URL: ${currentUrl}`);
      
      // 检查是否遇到Cloudflare保护
      if (title.includes('Attention Required') || title.includes('Cloudflare')) {
        logToFile(`检测到Cloudflare保护页面，终止爬虫`, true);
        // 立即抛出错误，不尝试解决
        throw new Error('检测到Cloudflare保护，终止爬虫');
      }
      
      // 从URL判断是买家还是供应商页面
      const isBuyerPage = currentUrl.includes('/result/buyer/');
      const isSupplierPage = currentUrl.includes('/result/supplier/');
      const pageType = isBuyerPage ? 'buyer' : (isSupplierPage ? 'supplier' : 'unknown');
      
      // 提取结构化公司数据列表
      const companies = await page.evaluate(() => {
        const companyList: Array<{name: string, shipments: string}> = [];
        
        // 根据截图分析，每个公司项目都有一个复选框和公司名
        // 先定位所有公司项
        const companyRows = document.querySelectorAll('li.ng-star-inserted, .ikclist_box, li.iklist');
        
        companyRows.forEach(row => {
          // 查找公司名称 - 通常是在复选框后面的第一个链接或标题
          const companyNameElement = row.querySelector('a, h5.ng-star-inserted');
          if (!companyNameElement) return;
          
          // 获取公司名称文本
          let companyName = companyNameElement.textContent?.trim() || '';
          if (!companyName) return;
          
          // 清理公司名称，确保不包含运输数据
          companyName = companyName.replace(/\d+\s*(?:matching\s*shipments|shipments\s*total)/gi, '').trim();
          
          // 查找运输数据 - 有两部分：matching shipments 和 shipments total
          let matchingShipments = '';
          let shipmentsTotal = '';
          
          // 试图找到专用于显示运输数据的元素
          const shipmentElements = row.querySelectorAll('.ikcp_desc, app-number-viewer, span.ng-star-inserted');
          shipmentElements.forEach(el => {
            const text = el.textContent?.trim() || '';
            if (text.includes('matching shipments')) {
              matchingShipments = text;
            } else if (text.includes('shipments total')) {
              shipmentsTotal = text;
            }
          });
          
          // 如果没有找到专门的元素，尝试在行内文本中查找
          if (!matchingShipments || !shipmentsTotal) {
            // 查找所有文本节点
            const allTextContent = row.textContent || '';
            
            // 尝试提取matching shipments
            const matchingMatch = allTextContent.match(/(\d+[K+]*\s*matching\s*shipments)/i);
            if (matchingMatch && !matchingShipments) {
              matchingShipments = matchingMatch[1];
            }
            
            // 尝试提取shipments total
            const totalMatch = allTextContent.match(/(\d+[K+]*\s*shipments\s*total)/i);
            if (totalMatch && !shipmentsTotal) {
              shipmentsTotal = totalMatch[1];
            }
          }
          
          // 合并运输数据
          const shipmentData = [matchingShipments, shipmentsTotal].filter(Boolean).join(' ');
          
          // 添加到结果列表
          companyList.push({
            name: companyName,
            shipments: shipmentData
          });
        });
        
        // 去除重复项，确保公司名唯一
        const uniqueCompanies = [];
        const companyNames = new Set();
        
        for (const company of companyList) {
          const name = company.name.toLowerCase();
          
          // 排除导航按钮和页面元素
          if (name.includes('previous') || 
              name.includes('next') || 
              name.includes('page') ||
              name.includes('buyer') ||
              name.includes('supplier') ||
              name.length < 3) {
            continue;
          }
          
          // 如果公司名称之前没有出现过，添加到结果
          if (!companyNames.has(name)) {
            companyNames.add(name);
            uniqueCompanies.push(company);
          }
        }
        
        return uniqueCompanies;
      });
      
      logToFile(`提取到 ${companies.length} 个公司数据`);
      
      // 清理和格式化公司数据
      const cleanedCompanies = companies.map(company => {
        let companyName = company.name || '';
        let shipmentData = company.shipments || '';
        
        // 从运输数据中提取配送数量
        let shipmentCount = '';
        const shipmentMatch = shipmentData.match(/(\d+[K+]*)\s*matching shipments/i);
        
        if (shipmentMatch) {
          shipmentCount = shipmentMatch[1];
        }
        
        return {
          companyName,
          shipmentData,
          shipmentCount
        };
      });
      
      // 过滤掉无效的公司数据，确保只保留真实的公司
      const validCompanies = cleanedCompanies.filter(company => {
        const name = company.companyName.toLowerCase();
        
        // 公司名称通常包含这些词
        const isLikelyCompany = /inc|ltd|llc|co\.|corp|s\.r\.o\.|company|ag|supply|retail|food|sa de cv|limited/.test(name);
        return isLikelyCompany;
      });
      
      return {
        title,
        url: currentUrl,
        pageType,
        companies: validCompanies,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logToFile(`提取ImportKey数据时出错: ${error}`, true);
      return {
        error: `数据提取失败: ${error instanceof Error ? error.message : String(error)}`,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * 关闭浏览器和清理资源
   */
  public static async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.browserPromise = null;
    }
    
    this.isLoggedIn = false;
    logToFile('ImportKey爬虫资源已关闭');
  }
} 