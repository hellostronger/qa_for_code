# Skills（自定义 Skill 目录）

此目录映射到容器内的个人级 Skill 位置 `/home/node/.claude/skills`。

## 结构

```
skills/
├── README.md
└── my-skill/
    ├── SKILL.md              # 必填：Skill 定义（含 frontmatter）
    └── (其他辅助文件/脚本)
```

## 说明

- 放进此目录的 skill 对所有 repo 生效（个人级），不依赖具体源码仓库
- 修改 skill 后重新提问即生效（每次 run 重新 spawn claude），无需重启容器
- 挂载为只读（`:ro`），Claude Code 只会读取 skill
- 如需项目级 skill（跟随某个源码仓库），放 `src-repo/.claude/skills/` 即可
