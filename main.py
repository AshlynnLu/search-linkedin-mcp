#!/usr/bin/env python3

import os
import asyncio
import json
import subprocess
import logging
import yaml
from typing import List, Dict, Any, Optional
from openai import OpenAI
from openai.types.beta.threads import Run
from openai.types.beta.assistant import Assistant
from openai.types.beta.thread import Thread

# 由于openai.types.mcp.server导入问题，我们创建自己的MCPServerStdio实现
class MCPServerStdio:
    """MCP服务器通过stdio通信的实现"""
    
    def __init__(self, params, cache_tools_list=False):
        """初始化MCP服务器连接
        
        Args:
            params: 启动参数，包含command和args
            cache_tools_list: 是否缓存工具列表
        """
        self.command = params.get("command", "node")
        self.args = params.get("args", [])
        self.env = params.get("env", None)  # 添加环境变量支持
        self.process = None
        self.cache_tools_list = cache_tools_list
        self._tools_cache = None
        self._next_request_id = 1
        self._initialized = False
    
    async def __aenter__(self):
        """启动服务器进程"""
        cmd = [self.command] + self.args
        self.process = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=self.env  # 传递环境变量给子进程
        )
        
        # 发送初始化请求
        await self._initialize()
        
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """关闭服务器进程"""
        if self.process:
            try:
                self.process.terminate()
                await self.process.wait()
            except:
                pass
            self.process = None
    
    async def _initialize(self):
        """初始化MCP服务器连接"""
        if self._initialized:
            return
        
        # 初始化请求
        init_request = {
            "jsonrpc": "2.0",
            "id": self._next_request_id,
            "method": "initialize",
            "params": {
                "protocolVersion": "0.5.0",
                "clientInfo": {
                    "name": "OpenAI Agent MCP Client",
                    "version": "1.0.0"
                },
                "capabilities": {
                    "tools": {}
                }
            }
        }
        self._next_request_id += 1
        
        # 发送初始化请求
        init_result = await self._send_request(init_request)
        self._initialized = True
        
        return init_result
    
    async def _send_request(self, request):
        """向MCP服务器发送请求"""
        if not self.process:
            raise RuntimeError("MCP服务器未启动")
        
        request_json = json.dumps(request) + "\n"
        self.process.stdin.write(request_json.encode())
        await self.process.stdin.drain()
        
        # 读取响应
        try:
            # 增加超时时间
            timeout = 30  # 秒
            response_line = await asyncio.wait_for(self.process.stdout.readline(), timeout)
            
            if not response_line:
                # 读取错误输出以便诊断
                stderr_data = await self.process.stderr.read(1024)
                if stderr_data:
                    logging.error(f"MCP服务器错误输出: {stderr_data.decode()}")
                raise Exception("空响应，可能是Node.js子进程没有输出")
                
            try:
                response = json.loads(response_line.decode())
            except json.JSONDecodeError as e:
                logging.error(f"JSON解析错误: {e}")
                logging.error(f"收到的原始响应: {response_line.decode()}")
                raise Exception(f"无法解析JSON响应: {e}")
            
            if "error" in response:
                raise Exception(f"MCP服务器错误: {response['error']}")
            
            return response.get("result")
        except asyncio.TimeoutError:
            logging.error(f"等待MCP服务器响应超时")
            # 读取错误输出以便诊断
            if self.process.stderr:
                stderr_data = await self.process.stderr.read(1024)
                if stderr_data:
                    logging.error(f"服务器错误输出: {stderr_data.decode()}")
            raise Exception("等待MCP服务器响应超时")
        except Exception as e:
            logging.error(f"MCP服务器通信错误: {e}")
            if self.process.stderr:
                stderr_data = await self.process.stderr.read(1024)
                if stderr_data:
                    logging.error(f"服务器错误输出: {stderr_data.decode()}")
            raise
    
    async def list_tools(self):
        """获取可用工具列表"""
        if self.cache_tools_list and self._tools_cache:
            return self._tools_cache
        
        request = {
            "jsonrpc": "2.0",
            "id": self._next_request_id,
            "method": "tools/list"
        }
        self._next_request_id += 1
        
        result = await self._send_request(request)
        
        if self.cache_tools_list:
            self._tools_cache = result
        
        return result
    
    async def call_tool(self, tool_name, arguments):
        """调用工具"""
        request = {
            "jsonrpc": "2.0",
            "id": self._next_request_id,
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": arguments
            }
        }
        self._next_request_id += 1
        
        result = await self._send_request(request)
        
        # 如果结果是文本内容的列表，提取文本
        if isinstance(result, dict) and 'content' in result:
            content = result.get('content', [])
            if isinstance(content, list) and len(content) > 0:
                for item in content:
                    if isinstance(item, dict) and item.get('type') == 'text':
                        text = item.get('text', '')
                        if text:
                            try:
                                return json.loads(text)
                            except:
                                return text
        
        return result
    
    def invalidate_tools_cache(self):
        """使工具缓存失效"""
        self._tools_cache = None

# 配置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class CompanyVerificationWorkflow:
    """公司信息验证工作流，确保工具按search->crawl->verify的顺序衔接"""
    
    def __init__(self, mcp_server):
        """初始化工作流"""
        self.mcp_server = mcp_server
        self.search_results = []
        self.crawl_results = []
        self.verify_results = []
    
    async def execute_search(self, company_name: str) -> Dict[str, Any]:
        """执行搜索步骤"""
        logger.info(f"开始搜索公司信息: {company_name}")
        search_args = {"company_name": company_name}
        result = await self.mcp_server.call_tool("search_company", search_args)
        
        # 解析搜索结果
        try:
            # 返回的结果可能已经是解析后的JSON对象
            if isinstance(result, dict) and "success" in result and "results" in result:
                self.search_results = result.get("results", [])
                logger.info(f"搜索成功，找到 {len(self.search_results)} 条结果")
            # 或者可能是字符串，需要解析
            elif isinstance(result, str):
                try:
                    parsed_result = json.loads(result)
                    if parsed_result.get("success") and "results" in parsed_result:
                        self.search_results = parsed_result["results"]
                        logger.info(f"搜索成功，找到 {len(self.search_results)} 条结果")
                    else:
                        logger.warning(f"搜索结果格式不符合预期: {parsed_result}")
                except json.JSONDecodeError:
                    logger.error(f"无法解析搜索结果: {result}")
            else:
                logger.error(f"搜索结果类型异常: {type(result)}")
                logger.debug(f"原始搜索结果: {result}")
        except Exception as e:
            logger.error(f"处理搜索结果时出错: {e}")
        
        return {"search_results": self.search_results}
    
    async def extract_linkedin_urls(self) -> List[str]:
        """从搜索结果中提取LinkedIn页面URL"""
        linkedin_urls = []
        for result in self.search_results:
            url = result.get("url", "")
            # 检查URL是否为LinkedIn公司页面
            if "linkedin.com/company/" in url.lower():
                linkedin_urls.append(url)
                logger.info(f"找到LinkedIn公司页面: {url}")
        
        logger.info(f"共提取到 {len(linkedin_urls)} 个LinkedIn公司页面")
        return linkedin_urls
    
    async def execute_crawl(self, urls: List[str]) -> Dict[str, Any]:
        """执行爬取步骤"""
        if not urls:
            logger.warning("没有找到LinkedIn页面URL，爬取步骤将被跳过")
            return {"crawl_results": []}
        
        logger.info(f"开始爬取 {len(urls)} 个LinkedIn页面")
        crawl_args = {"urls": urls}
        result = await self.mcp_server.call_tool("crawl_multiple_pages", crawl_args)
        
        # 解析爬取结果
        try:
            # 如果结果已经是字典类型
            if isinstance(result, dict):
                # 检查'results'字段（实际返回格式）
                if "success" in result and "results" in result:
                    self.crawl_results = result.get("results", [])
                    logger.info(f"爬取成功，获取到 {len(self.crawl_results)} 个页面内容")
                # 兼容'pages'字段（原预期格式）
                elif "success" in result and "pages" in result:
                    self.crawl_results = result.get("pages", [])
                    logger.info(f"爬取成功，获取到 {len(self.crawl_results)} 个页面内容")
                else:
                    logger.warning(f"爬取结果格式不符合预期: {result}")
            # 如果结果是字符串，尝试解析为JSON
            elif isinstance(result, str):
                try:
                    parsed_result = json.loads(result)
                    # 检查'results'字段（实际返回格式）
                    if parsed_result.get("success") and "results" in parsed_result:
                        self.crawl_results = parsed_result["results"]
                        logger.info(f"爬取成功，获取到 {len(self.crawl_results)} 个页面内容")
                    # 兼容'pages'字段（原预期格式）
                    elif parsed_result.get("success") and "pages" in parsed_result:
                        self.crawl_results = parsed_result["pages"]
                        logger.info(f"爬取成功，获取到 {len(self.crawl_results)} 个页面内容")
                    else:
                        logger.warning(f"爬取结果格式不符合预期: {parsed_result}")
                except json.JSONDecodeError:
                    logger.error(f"无法解析爬取结果: {result}")
            else:
                logger.error(f"爬取结果类型异常: {type(result)}")
                logger.debug(f"原始爬取结果: {result}")
        except Exception as e:
            logger.error(f"处理爬取结果时出错: {e}")
        
        return {"crawl_results": self.crawl_results}
    
    async def execute_verify(self, company_name: str, official_website: Optional[str] = None) -> Dict[str, Any]:
        """执行验证步骤"""
        if not self.crawl_results:
            logger.warning("没有爬取结果，验证步骤将被跳过")
            return {"verify_results": []}
        
        # 准备验证参数
        pages = []
        for page in self.crawl_results:
            if page.get("content") and page.get("url"):
                pages.append({
                    "url": page["url"],
                    "content": page["content"]
                })
        
        if not pages:
            logger.warning("没有有效的页面内容，验证步骤将被跳过")
            return {"verify_results": []}
        
        logger.info(f"开始验证 {len(pages)} 个页面内容是否匹配公司: {company_name}")
        verify_args = {
            "company_name": company_name,
            "pages": pages
        }
        
        if official_website:
            verify_args["official_website"] = official_website
        
        result = await self.mcp_server.call_tool("verify_multiple_contents", verify_args)
        
        # 解析验证结果
        try:
            # 如果结果已经是字典类型
            if isinstance(result, dict):
                # 检查'results'字段（实际返回格式）
                if "success" in result and "results" in result:
                    self.verify_results = result.get("results", [])
                    logger.info(f"验证成功，得到 {len(self.verify_results)} 个验证结果")
                    
                    # 存储有用的验证信息以便在结果中使用
                    self.best_match = result.get("best_match")
                    self.linkedin_url = result.get("linkedin_url")
                    self.linkedin_found = result.get("linkedin", False)
                    self.match_count = result.get("match_count", 0)
                # 兼容'verifications'字段（原预期格式）
                elif "success" in result and "verifications" in result:
                    self.verify_results = result.get("verifications", [])
                    logger.info(f"验证成功，得到 {len(self.verify_results)} 个验证结果")
                else:
                    logger.warning(f"验证结果格式不符合预期: {result}")
            # 如果结果是字符串，尝试解析为JSON
            elif isinstance(result, str):
                try:
                    parsed_result = json.loads(result)
                    # 检查'results'字段（实际返回格式）
                    if parsed_result.get("success") and "results" in parsed_result:
                        self.verify_results = parsed_result["results"]
                        logger.info(f"验证成功，得到 {len(self.verify_results)} 个验证结果")
                        
                        # 存储有用的验证信息以便在结果中使用
                        self.best_match = parsed_result.get("best_match")
                        self.linkedin_url = parsed_result.get("linkedin_url") 
                        self.linkedin_found = parsed_result.get("linkedin", False)
                        self.match_count = parsed_result.get("match_count", 0)
                    # 兼容'verifications'字段（原预期格式）
                    elif parsed_result.get("success") and "verifications" in parsed_result:
                        self.verify_results = parsed_result["verifications"]
                        logger.info(f"验证成功，得到 {len(self.verify_results)} 个验证结果")
                    else:
                        logger.warning(f"验证结果格式不符合预期: {parsed_result}")
                except json.JSONDecodeError:
                    logger.error(f"无法解析验证结果: {result}")
            else:
                logger.error(f"验证结果类型异常: {type(result)}")
                logger.debug(f"原始验证结果: {result}")
        except Exception as e:
            logger.error(f"处理验证结果时出错: {e}")
        
        return {"verify_results": self.verify_results}
    
    async def run_complete_workflow(self, company_name: str, official_website: Optional[str] = None) -> Dict[str, Any]:
        """执行完整的工作流程：搜索->爬取->验证"""
        # 初始化成员变量
        self.best_match = None
        self.linkedin_url = None
        self.linkedin_found = False
        self.match_count = 0
        
        # 步骤1: 搜索公司信息
        search_result = await self.execute_search(company_name)
        
        # 步骤2: 从搜索结果中提取LinkedIn URL
        linkedin_urls = await self.extract_linkedin_urls()
        
        # 步骤3: 爬取LinkedIn页面
        crawl_result = await self.execute_crawl(linkedin_urls)
        
        # 步骤4: 验证页面内容
        verify_result = await self.execute_verify(company_name, official_website)
        
        # 合并所有结果
        final_result = {
            "company_name": company_name,
            "search": search_result,
            "crawl": crawl_result,
            "verify": verify_result,
            "success": self.linkedin_found and self.match_count > 0
        }
        
        if official_website:
            final_result["official_website"] = official_website
        
        # 添加LinkedIn匹配信息
        if self.linkedin_found:
            final_result["linkedin_found"] = True
            final_result["linkedin_url"] = self.linkedin_url
            final_result["match_count"] = self.match_count
        
        # 添加最佳匹配结果
        if self.best_match:
            final_result["best_match"] = self.best_match
        
        return final_result


class OpenAIAgentWithMCP:
    """使用OpenAI Agent与MCP服务器交互的类"""
    
    def __init__(self, api_key=None, assistant_id=None, model="gpt-4-turbo"):
        """初始化OpenAI客户端和Assistant"""
        self.api_key = api_key or os.environ.get("OPENAI_API_KEY")
        if not self.api_key:
            raise ValueError("OPENAI_API_KEY未设置，请提供OpenAI API密钥")
        
        self.client = OpenAI(api_key=self.api_key)
        self.assistant_id = assistant_id
        self.assistant = None
        self.thread = None
        self.model = model
        self.mcp_server_process = None
        self.mcp_server = None
        self.workflow = None
    
    async def start_mcp_server(self):
        """启动MCP服务器并连接到它"""
        logger.info("启动MCP服务器...")
        
        # 启动MCP服务器的命令
        mcp_server_path = "./build/index.js"  # 基于项目构建路径
        
        # 创建MCP服务器连接
        self.mcp_server = MCPServerStdio(
            params={
                "command": "node",
                "args": [mcp_server_path],
            },
            cache_tools_list=True  # 缓存工具列表以提高性能
        )
        
        # 开始连接MCP服务器
        await self.mcp_server.__aenter__()
        
        # 获取可用工具列表
        tools = await self.mcp_server.list_tools()
        logger.info(f"MCP服务器工具加载完成，共{len(tools['tools'])}个工具")
        
        # 初始化工作流
        self.workflow = CompanyVerificationWorkflow(self.mcp_server)
        
        return tools
    
    async def create_assistant_if_needed(self):
        """创建或获取助手"""
        if self.assistant_id:
            try:
                self.assistant = self.client.beta.assistants.retrieve(self.assistant_id)
                logger.info(f"已获取现有助手: {self.assistant.name}")
                return self.assistant
            except Exception as e:
                logger.warning(f"获取助手失败: {e}，将创建新助手")
        
        # 获取MCP服务器工具
        tools_data = await self.start_mcp_server()
        
        # 将MCP工具转换为OpenAI可接受的格式
        openai_tools = [
            {
                "type": "function",
                "function": {
                    "name": tool.get("name", f"tool_{i}"),
                    "description": tool.get("description", "MCP工具"),
                    "parameters": {
                        "type": "object",
                        "properties": {},
                        "required": []
                    }
                }
            }
            for i, tool in enumerate(tools_data.get("tools", []))
        ]
        
        # 为每个工具添加参数定义
        for i, tool in enumerate(tools_data.get("tools", [])):
            tool_name = tool.get("name", "")
            if tool_name == "search_company":
                openai_tools[i]["function"]["parameters"] = {
                    "type": "object",
                    "properties": {
                        "company_name": {
                            "type": "string",
                            "description": "要搜索的公司名称"
                        }
                    },
                    "required": ["company_name"]
                }
            elif tool_name == "crawl_multiple_pages":
                openai_tools[i]["function"]["parameters"] = {
                    "type": "object",
                    "properties": {
                        "urls": {
                            "type": "array",
                            "items": {
                                "type": "string"
                            },
                            "description": "要爬取的URL列表"
                        }
                    },
                    "required": ["urls"]
                }
            elif tool_name == "verify_multiple_contents":
                openai_tools[i]["function"]["parameters"] = {
                    "type": "object",
                    "properties": {
                        "company_name": {
                            "type": "string",
                            "description": "公司名称"
                        },
                        "pages": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "url": {
                                        "type": "string"
                                    },
                                    "content": {
                                        "type": "string"
                                    }
                                }
                            },
                            "description": "要验证的页面内容列表"
                        },
                        "official_website": {
                            "type": "string",
                            "description": "公司官方网站（可选）"
                        }
                    },
                    "required": ["company_name", "pages"]
                }
        
        # 创建新助手
        self.assistant = self.client.beta.assistants.create(
            name="商机通助手",
            instructions="你是一个帮助验证公司信息的AI助手，可以搜索、提取和验证公司信息。你有以下工具可用：\n1. search_company: 搜索公司信息\n2. crawl_multiple_pages: 爬取多个LinkedIn页面\n3. verify_multiple_contents: 验证页面内容是否匹配公司",
            model=self.model,
            tools=openai_tools
        )
        self.assistant_id = self.assistant.id
        logger.info(f"已创建新助手，ID: {self.assistant_id}")
        return self.assistant
    
    async def create_thread(self):
        """创建新的对话线程"""
        self.thread = self.client.beta.threads.create()
        logger.info(f"已创建新对话线程，ID: {self.thread.id}")
        return self.thread
    
    async def send_message(self, content):
        """向线程发送消息"""
        if not self.thread:
            await self.create_thread()
        
        message = self.client.beta.threads.messages.create(
            thread_id=self.thread.id,
            role="user",
            content=content
        )
        logger.info(f"已发送用户消息: {content[:50]}...")
        return message
    
    async def run_thread(self):
        """运行线程并等待完成"""
        if not self.assistant:
            await self.create_assistant_if_needed()
        
        run = self.client.beta.threads.runs.create(
            thread_id=self.thread.id,
            assistant_id=self.assistant.id
        )
        logger.info(f"已启动运行，ID: {run.id}")
        
        # 等待运行完成或需要响应
        while True:
            run = self.client.beta.threads.runs.retrieve(
                thread_id=self.thread.id,
                run_id=run.id
            )
            
            # 检查运行状态
            if run.status == "requires_action" and run.required_action and run.required_action.type == "submit_tool_outputs":
                logger.info("需要执行工具调用")
                
                # 处理工具调用请求
                tool_calls = run.required_action.submit_tool_outputs.tool_calls
                tool_outputs = []
                
                for tool_call in tool_calls:
                    function_name = tool_call.function.name
                    function_args = json.loads(tool_call.function.arguments)
                    
                    logger.info(f"调用工具: {function_name}，参数: {function_args}")
                    
                    try:
                        # 执行MCP工具调用
                        if function_name == "search_company":
                            result = await self.mcp_server.call_tool("search_company", function_args)
                        elif function_name == "crawl_multiple_pages":
                            result = await self.mcp_server.call_tool("crawl_multiple_pages", function_args)
                        elif function_name == "verify_multiple_contents":
                            result = await self.mcp_server.call_tool("verify_multiple_contents", function_args)
                        else:
                            result = {"error": f"未知工具: {function_name}"}
                        
                        # 将结果转换为字符串
                        result_str = json.dumps(result, ensure_ascii=False)
                        
                    except Exception as e:
                        logger.error(f"工具调用失败: {e}")
                        result_str = json.dumps({"error": str(e)}, ensure_ascii=False)
                    
                    # 添加到输出结果
                    tool_outputs.append({
                        "tool_call_id": tool_call.id,
                        "output": result_str
                    })
                
                # 提交工具调用结果
                run = self.client.beta.threads.runs.submit_tool_outputs(
                    thread_id=self.thread.id,
                    run_id=run.id,
                    tool_outputs=tool_outputs
                )
                logger.info("已提交工具调用结果")
            
            # 检查是否完成
            elif run.status in ["completed", "failed", "cancelled", "expired"]:
                logger.info(f"运行完成，最终状态: {run.status}")
                break
            
            # 继续等待
            else:
                logger.info(f"运行状态: {run.status}，等待完成...")
                await asyncio.sleep(2)  # 轮询间隔
        
        return run
    
    async def get_assistant_responses(self):
        """获取助手的回复"""
        messages = self.client.beta.threads.messages.list(
            thread_id=self.thread.id
        )
        
        # 筛选出助手的回复
        assistant_messages = [msg for msg in messages.data if msg.role == "assistant"]
        responses = []
        
        for msg in assistant_messages:
            for content in msg.content:
                if content.type == "text":
                    responses.append(content.text.value)
        
        return responses
    
    async def direct_verify_company(self, company_name: str, official_website: Optional[str] = None):
        """直接使用工作流验证公司信息，无需通过Assistant"""
        if not self.mcp_server:
            await self.start_mcp_server()
        
        logger.info(f"开始直接验证公司: {company_name}")
        results = await self.workflow.run_complete_workflow(company_name, official_website)
        return results
    
    async def close(self):
        """关闭MCP服务器连接"""
        if self.mcp_server:
            await self.mcp_server.__aexit__(None, None, None)
            logger.info("MCP服务器连接已关闭")


async def load_config(config_file="openai.yaml"):
    """从配置文件加载设置"""
    try:
        with open(config_file, 'r', encoding='utf-8') as f:
            config = yaml.safe_load(f)
        logger.info(f"配置已从 {config_file} 加载")
        return config
    except Exception as e:
        logger.error(f"加载配置失败: {e}")
        return {}


async def interactive_session():
    """交互式会话示例"""
    config = await load_config()
    api_key = os.environ.get("OPENAI_API_KEY")
    
    agent = OpenAIAgentWithMCP(api_key=api_key)
    
    try:
        # 确保Assistant已创建
        await agent.create_assistant_if_needed()
        
        # 创建对话线程
        await agent.create_thread()
        
        print("=== 商机通验证工具 交互式测试模式 ===")
        print("您可以输入公司名称进行搜索和验证，输入 'exit' 退出。")
        
        while True:
            user_input = input("\n请输入公司名称 (输入'exit'退出): ").strip()
            
            if user_input.lower() in ['exit', 'quit', '退出']:
                break
            
            # 可选的官方网站
            official_website = input("请输入官方网站 (可选，直接回车跳过): ").strip()
            if not official_website:
                official_website = None
                
            # 是否显示详细结果
            show_detail = input("是否显示详细结果? (y/n): ").strip().lower() == 'y'
            
            # 选择测试方式
            test_type = input("选择测试方式: 1=直接工作流, 2=OpenAI Assistant (默认1): ").strip()
            if not test_type or test_type == '1':
                # 使用工作流程直接验证
                print(f"=== 开始测试工作流: 公司名称 '{user_input}' ===")
                print("执行验证工作流...")
                result = await agent.direct_verify_company(user_input, official_website)
                
                # 打印结果摘要
                print("\n=== 验证结果摘要 ===")
                
                if result.get("success"):
                    print(f"✓ 成功: 找到匹配的LinkedIn页面: {result.get('linkedin_url', 'N/A')}")
                    if "best_match" in result:
                        best_match = result["best_match"]
                        print(f"最佳匹配: {best_match.get('url', 'N/A')}")
                        print(f"匹配分数: {best_match.get('match_score', 'N/A')}/10")
                        # 打印匹配详情
                        if "details" in best_match:
                            details = best_match["details"]
                            print(f"详细分数:")
                            print(f" - 名称匹配: {details.get('name_score', 'N/A')}/10")
                            print(f" - 业务匹配: {details.get('business_score', 'N/A')}/10")
                            print(f" - 可信度: {details.get('credibility_score', 'N/A')}/10")
                            print(f" - 网站匹配: {details.get('website_score', 'N/A')}/10")
                else:
                    print("✗ 失败: 未找到匹配的LinkedIn页面")
                
                # 处理统计信息
                print("\n=== 处理统计 ===")
                print(f"- 搜索: 找到 {len(result.get('search', {}).get('search_results', []))} 条结果")
                print(f"- 爬取: 处理了 {len(result.get('crawl', {}).get('crawl_results', []))} 个页面")
                print(f"- 验证: 分析了 {len(result.get('verify', {}).get('verify_results', []))} 个页面")
                
                # 是否需要详细结果
                if show_detail:
                    print("\n=== 详细结果 ===")
                    print(json.dumps(result, ensure_ascii=False, indent=2))
            else:
                # 使用OpenAI Assistant验证
                print(f"\n=== 开始OpenAI Assistant测试: 公司名称 '{user_input}' ===")
                
                prompt = f"请帮我验证公司 '{user_input}' 的信息"
                if official_website:
                    prompt += f"，官方网站是 {official_website}"
                
                # 发送消息
                await agent.send_message(prompt)
                
                # 运行对话
                run = await agent.run_thread()
                
                # 获取回复
                responses = await agent.get_assistant_responses()
                for i, response in enumerate(responses):
                    print(f"\nAssistant回复:\n{response}\n")
    
    finally:
        # 关闭连接
        await agent.close()


async def main():
    """主函数：演示如何使用OpenAI Agent调用MCP服务器"""
    # 从环境变量获取API密钥
    api_key = os.environ.get("OPENAI_API_KEY")
    
    # 初始化Agent
    agent = OpenAIAgentWithMCP(api_key=api_key)
    
    try:
        # 示例1: 使用OpenAI Assistant
        print("示例1: 使用OpenAI Assistant")
        # 确保Assistant已创建
        await agent.create_assistant_if_needed()
        
        # 创建对话线程
        await agent.create_thread()
        
        # 发送初始消息
        await agent.send_message("你好，请帮我搜索关于'苹果公司'的信息，验证它是否是一家科技公司。")
        
        # 运行对话
        run = await agent.run_thread()
        
        # 获取回复
        responses = await agent.get_assistant_responses()
        for i, response in enumerate(responses):
            print(f"回复 {i+1}:\n{response}\n")
        
        # 示例2: 直接使用工作流
        print("\n示例2: 直接使用工作流")
        result = await agent.direct_verify_company("苹果公司", "apple.com")
        print("直接验证结果:")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        
        # 示例3: 交互式会话
        print("\n示例3: 启动交互式会话")
        await interactive_session()
    
    finally:
        # 关闭连接
        await agent.close()


if __name__ == "__main__":
    asyncio.run(main()) 