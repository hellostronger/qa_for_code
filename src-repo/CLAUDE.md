# FastGPT

FastGPT 是一个基于 LLM 的知识库问答系统，提供开箱即用的数据处理、模型调用、RAG 检索、可视化 AI 工作流等功能。

## 技术栈
- Next.js 14 + TypeScript (前端)
- Node.js + TypeScript (后端服务)
- PostgreSQL (关系数据) + MongoDB (日志/数据集)
- Pnpm Monorepo (packages/ + projects/)

## 目录结构
- packages/ — 共享库
  - packages/global/ — 全局类型、常量、工具函数
  - packages/service/ — 后端服务 (tRPC + Fastify)
  - packages/web/ — 前端公共组件
  - packages/plugins/ — 插件系统
- projects/
  - projects/app/ — 主应用 (Next.js)
  - projects/app/src/pages/api/ — API 路由
  - projects/app/src/components/ — React 组件
  - projects/app/src/service/ — 前端 service 层
  - projects/app/src/web/ — 页面
- docs/ — 文档
- scripts/ — 工具脚本

## 核心业务概念
- **知识库 (KB)**: 用户上传文档 → 切片 → 向量化 → 存入向量数据库
- **应用 (App)**: 关联知识库 + 配置 Prompt + 选择合适的 LLM 模型
- **工作流 (Workflow)**: 可视化编排 AI 处理流程 (插件系统)
- **对话 (Chat)**: 用户与 AI 应用的多轮对话

## API 命名约定
- GET /api/core/kb/list — 获取知识库列表
- POST /api/core/kb/create — 创建知识库
- POST /api/core/chat/outLink — 外部链接对话
- GET /api/core/app/list — 获取应用列表

## 关键文件
- projects/app/src/pages/api/core/chat/outLink.ts — 外部对话 API
- packages/service/src/core/kb/ — 知识库核心逻辑
- packages/plugins/src/ — 插件运行时引擎
