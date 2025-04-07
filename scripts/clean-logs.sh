#!/bin/bash

# 清理所有日志文件
echo "正在清理日志文件..."

# 主要日志文件
rm -f mcp-server.log
rm -f crawler.log
rm -f google.log
rm -f companyVerifier.log
rm -f llm.log

echo "日志文件已清理完成" 