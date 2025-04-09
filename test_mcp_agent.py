#!/usr/bin/env python3

import os
import sys
import asyncio
import argparse
import json
from dotenv import load_dotenv

# 加载环境变量
load_dotenv()

# 导入主模块
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from main import OpenAIAgentWithMCP, CompanyVerificationWorkflow

async def test_workflow(company_name, official_website=None, verbose=False):
    """测试工作流功能"""
    print(f"=== 开始测试工作流: 公司名称 '{company_name}' ===")
    
    # 初始化Agent
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("错误: 未设置OPENAI_API_KEY环境变量")
        return False
    
    agent = OpenAIAgentWithMCP(api_key=api_key)
    
    try:
        # 启动MCP服务器
        await agent.start_mcp_server()
        
        # 执行工作流
        print(f"执行验证工作流...")
        result = await agent.direct_verify_company(company_name, official_website)
        
        # 打印结果摘要
        print("\n=== 验证结果摘要 ===")
        if result.get("success"):
            if "best_match" in result:
                best_match = result["best_match"]
                print(f"✓ 成功: 找到匹配的LinkedIn页面")
                print(f"  - URL: {best_match.get('url', 'N/A')}")
                print(f"  - 匹配度: {best_match.get('match_score', 'N/A')}")
                print(f"  - 验证结果: {best_match.get('result_summary', 'N/A')}")
            else:
                print("✓ 成功: 但未找到最佳匹配页面")
        else:
            print("✗ 失败: 未找到匹配的LinkedIn页面")
        
        # 输出步骤统计
        print("\n=== 处理统计 ===")
        print(f"- 搜索: 找到 {len(result.get('search', {}).get('search_results', []))} 条结果")
        print(f"- 爬取: 处理了 {len(result.get('crawl', {}).get('crawl_results', []))} 个页面")
        print(f"- 验证: 分析了 {len(result.get('verify', {}).get('verify_results', []))} 个页面")
        
        # 详细信息
        if verbose:
            print("\n=== 详细结果 ===")
            print(json.dumps(result, ensure_ascii=False, indent=2))
            
        return result.get("success", False)
        
    except Exception as e:
        print(f"测试过程中出错: {e}")
        return False
    finally:
        # 关闭服务器连接
        await agent.close()

async def test_assistant(company_name, verbose=False):
    """测试OpenAI Assistant的功能"""
    print(f"=== 开始测试OpenAI Assistant: 公司名称 '{company_name}' ===")
    
    # 初始化Agent
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("错误: 未设置OPENAI_API_KEY环境变量")
        return False
    
    agent = OpenAIAgentWithMCP(api_key=api_key)
    
    try:
        # 创建Assistant
        await agent.create_assistant_if_needed()
        
        # 创建线程
        await agent.create_thread()
        
        # 发送请求
        print("向Assistant发送请求...")
        await agent.send_message(f"你好，请帮我验证'{company_name}'公司的信息，看看它是什么类型的公司，总部在哪里。")
        
        # 运行线程
        print("等待Assistant处理...")
        run = await agent.run_thread()
        
        # 获取回复
        responses = await agent.get_assistant_responses()
        
        print("\n=== Assistant回复 ===")
        for i, response in enumerate(responses):
            print(f"回复 {i+1}:\n{response}\n")
            
        return True
        
    except Exception as e:
        print(f"测试过程中出错: {e}")
        return False
    finally:
        # 关闭服务器连接
        await agent.close()

async def interactive_test():
    """交互式测试模式"""
    print("=== 商机通验证工具 交互式测试模式 ===")
    print("您可以输入公司名称进行搜索和验证，输入 'exit' 退出。")
    
    # 初始化Agent
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("错误: 未设置OPENAI_API_KEY环境变量")
        return False
    
    agent = OpenAIAgentWithMCP(api_key=api_key)
    
    try:
        # 启动MCP服务器
        await agent.start_mcp_server()
        
        while True:
            # 获取公司名称
            company_name = input("\n请输入公司名称 (输入'exit'退出): ").strip()
            if company_name.lower() in ['exit', 'quit', '退出']:
                break
                
            if not company_name:
                continue
                
            # 获取官方网站（可选）
            official_website = input("请输入官方网站 (可选，直接回车跳过): ").strip()
            if not official_website:
                official_website = None
                
            # 显示详细信息？
            verbose_input = input("是否显示详细结果? (y/n): ").strip().lower()
            verbose = verbose_input == 'y'
            
            # 选择测试方式
            test_mode = input("选择测试方式: 1=直接工作流, 2=OpenAI Assistant (默认1): ").strip()
            
            if test_mode == '2':
                # 使用Assistant
                await test_assistant(company_name, verbose)
            else:
                # 使用工作流
                await test_workflow(company_name, official_website, verbose)
                
    except Exception as e:
        print(f"测试过程中出错: {e}")
    finally:
        # 关闭服务器连接
        await agent.close()

def parse_args():
    """解析命令行参数"""
    parser = argparse.ArgumentParser(description="商机通MCP服务器测试工具")
    
    # 互斥参数组，只能使用其中一种模式
    mode_group = parser.add_mutually_exclusive_group()
    mode_group.add_argument('-i', '--interactive', action='store_true', 
                          help='交互式测试模式')
    mode_group.add_argument('-w', '--workflow', action='store_true', 
                          help='测试工作流')
    mode_group.add_argument('-a', '--assistant', action='store_true', 
                          help='测试OpenAI Assistant')
    
    # 其他参数
    parser.add_argument('-c', '--company', type=str, 
                       help='公司名称')
    parser.add_argument('-o', '--official-website', type=str, 
                       help='公司官方网站')
    parser.add_argument('-v', '--verbose', action='store_true', 
                       help='显示详细信息')
    
    return parser.parse_args()

async def main():
    """主函数"""
    # 解析命令行参数
    args = parse_args()
    
    # 交互式模式
    if args.interactive:
        await interactive_test()
        return
        
    # 测试工作流
    if args.workflow:
        if not args.company:
            print("错误: 使用工作流测试模式时，必须指定公司名称 (-c/--company)")
            return
        await test_workflow(args.company, args.official_website, args.verbose)
        return
        
    # 测试Assistant
    if args.assistant:
        if not args.company:
            print("错误: 使用Assistant测试模式时，必须指定公司名称 (-c/--company)")
            return
        await test_assistant(args.company, args.verbose)
        return
        
    # 如果没有指定任何模式，默认进入交互式模式
    await interactive_test()

if __name__ == "__main__":
    # 确保正确加载dotenv
    if not os.environ.get("OPENAI_API_KEY"):
        print("警告: 未检测到OPENAI_API_KEY环境变量")
        print("请确保.env文件存在并包含必要的API密钥")
    
    asyncio.run(main()) 