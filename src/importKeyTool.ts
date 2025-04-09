import { ImportKeyCrawler } from './importKeyCrawler.js';
import * as fs from 'fs';
import { getParamValue, ENV_NAMES, getAuthValue } from './config/env.js';

// 简单日志辅助函数，输出到文件
const logToFile = (message: string, isError = false) => {
  try {
    // 日志消息添加时间戳
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    // 追加到日志文件
    fs.appendFileSync('importkey-tool.log', logMessage);
  } catch {
    // 忽略日志错误
  }
};

// 环境变量名称
export const IMPORTKEY_ENV_NAMES = {
  EMAIL: 'IMPORTKEY_EMAIL',
  PASSWORD: 'IMPORTKEY_PASSWORD'
};

/**
 * ImportKey数据爬取工具，用于爬取海关数据
 */
export class ImportKeyTool {
  private static initialized = false;

  /**
   * 初始化ImportKey工具
   * @param request 可选的MCP请求对象
   */
  private static async init(request?: any): Promise<boolean> {
    if (this.initialized) {
      return true;
    }

    try {
      // 获取登录凭证，优先使用请求中的认证信息
      const emailFromRequest = request ? getAuthValue(request, IMPORTKEY_ENV_NAMES.EMAIL) : null;
      const passwordFromRequest = request ? getAuthValue(request, IMPORTKEY_ENV_NAMES.PASSWORD) : null;
      
      const email = emailFromRequest || getParamValue(IMPORTKEY_ENV_NAMES.EMAIL);
      const password = passwordFromRequest || getParamValue(IMPORTKEY_ENV_NAMES.PASSWORD);
      
      if (!email || !password) {
        logToFile('ImportKey登录凭证未设置', true);
        return false;
      }
      
      // 初始化爬虫
      ImportKeyCrawler.init(email, password);
      this.initialized = true;
      logToFile('ImportKey工具初始化成功');
      return true;
    } catch (error) {
      logToFile(`ImportKey工具初始化失败: ${error}`, true);
      return false;
    }
  }

  /**
   * 获取公司海关数据
   * @param companyName 公司名称
   * @param request 可选的MCP请求对象
   * @returns 公司海关数据
   */
  public static async getCompanyCustomsData(companyName: string, request?: any): Promise<any> {
    // 确保已初始化
    if (!(await this.init(request))) {
      throw new Error('ImportKey工具初始化失败，请检查登录凭证');
    }
    
    try {
      logToFile(`开始获取"${companyName}"的海关数据`);
      
      // 设置超时控制
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('海关数据获取超时')), 180000) // 3分钟
      );
      
      // 并行爬取买家和供应商数据，增加超时处理
      const crawlPromise = Promise.all([
        ImportKeyCrawler.crawlBuyerData(companyName),
        ImportKeyCrawler.crawlSupplierData(companyName)
      ]);
      
      // 使用Race来处理可能的超时
      const [buyerData, supplierData] = await Promise.race([
        crawlPromise,
        timeoutPromise.then(() => { throw new Error('海关数据获取超时'); })
      ]) as [any, any];
      
      // 处理买家数据
      const processedBuyerData = this.processCustomsData(buyerData, 'buyer');
      
      // 处理供应商数据
      const processedSupplierData = this.processCustomsData(supplierData, 'supplier');
      
      logToFile(`完成获取"${companyName}"的海关数据`);
      
      return {
        company_name: companyName,
        buyer_data: processedBuyerData,
        supplier_data: processedSupplierData,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logToFile(`获取"${companyName}"的海关数据失败: ${error}`, true);
      throw error;
    }
  }

  /**
   * 处理爬虫获取的海关数据
   * @param rawData 原始数据
   * @param dataType 数据类型
   * @returns 处理后的数据
   */
  private static processCustomsData(rawData: any, dataType: 'buyer' | 'supplier'): any {
    // 如果数据为空或包含错误，则返回null
    if (!rawData || rawData.error) {
      return null;
    }
    
    try {
      const result = {
        summary: `${dataType === 'buyer' ? '买家' : '供应商'}数据`,
        companies: []
      };
      
      // 检查是否有公司数据
      if (rawData.companies && Array.isArray(rawData.companies)) {
        result.companies = rawData.companies.map((company: any) => ({
          name: company.companyName,
          shipment_info: company.shipmentData,
          type: dataType
        }));
        
        logToFile(`处理${dataType}数据: 找到 ${result.companies.length} 个公司`);
      } else {
        logToFile(`处理${dataType}数据: 未找到公司数据`, true);
      }
      
      return result;
    } catch (error) {
      logToFile(`处理${dataType}数据时出错: ${error}`, true);
      return null;
    }
  }

  /**
   * 关闭ImportKey工具并清理资源
   */
  public static async close(): Promise<void> {
    if (this.initialized) {
      await ImportKeyCrawler.close();
      this.initialized = false;
      logToFile('ImportKey工具已关闭');
    }
  }
} 