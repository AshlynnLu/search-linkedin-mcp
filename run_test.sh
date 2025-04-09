#!/bin/bash

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # 无颜色

# 检查是否存在虚拟环境
if [ ! -d "venv" ]; then
    echo -e "${YELLOW}未检测到虚拟环境，开始创建...${NC}"
    python3 -m venv venv
    echo -e "${GREEN}虚拟环境创建完成${NC}"
fi

# 激活虚拟环境
echo -e "${BLUE}激活虚拟环境...${NC}"
source venv/bin/activate

# 检查并安装依赖
echo -e "${BLUE}检查依赖项...${NC}"
pip install -r requirements.txt

# 检查环境变量
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}警告: 未找到 .env 文件${NC}"
    echo -e "${YELLOW}将从 .env.example 复制一份，请记得填写您的API密钥${NC}"
    cp .env.example .env
fi

# 确保MCP服务器已构建
echo -e "${BLUE}确保MCP服务器已构建...${NC}"
npm run build

# 运行测试
echo -e "${GREEN}启动测试...${NC}"

# 获取参数
if [ "$1" == "-i" ] || [ "$1" == "--interactive" ]; then
    echo -e "${BLUE}启动交互式测试模式...${NC}"
    python test_mcp_agent.py -i
elif [ "$1" == "-w" ] || [ "$1" == "--workflow" ]; then
    if [ -z "$2" ]; then
        echo -e "${RED}错误: 使用工作流模式时需要指定公司名称${NC}"
        echo -e "用法: $0 -w '公司名称' [官方网站]"
        exit 1
    fi
    
    COMPANY="$2"
    WEBSITE="$3"
    
    if [ -z "$WEBSITE" ]; then
        echo -e "${BLUE}测试工作流: 公司='$COMPANY'${NC}"
        python test_mcp_agent.py -w -c "$COMPANY" -v
    else
        echo -e "${BLUE}测试工作流: 公司='$COMPANY', 网站='$WEBSITE'${NC}"
        python test_mcp_agent.py -w -c "$COMPANY" -o "$WEBSITE" -v
    fi
elif [ "$1" == "-a" ] || [ "$1" == "--assistant" ]; then
    if [ -z "$2" ]; then
        echo -e "${RED}错误: 使用Assistant模式时需要指定公司名称${NC}"
        echo -e "用法: $0 -a '公司名称'"
        exit 1
    fi
    
    COMPANY="$2"
    echo -e "${BLUE}测试OpenAI Assistant: 公司='$COMPANY'${NC}"
    python test_mcp_agent.py -a -c "$COMPANY" -v
else
    echo -e "${BLUE}未指定测试模式，默认启动交互式测试...${NC}"
    python test_mcp_agent.py
fi

# 结束
echo -e "${GREEN}测试完成${NC}" 