## 外链显示配置

站点配置 `laf_external_links_enabled` 统一控制顶部的「文档、社区」和头像菜单的「商务合作、用户群（微信、Discord）」入口。

- 默认关闭；已有安装未配置该项时也不显示。
- 沿用 `Setting` 的字符串值格式：`value: "false"` 关闭，只有 `value: "true"` 开启；该配置须为 `public: true` 才能由 `/v1/settings` 返回给前端。
- 开启后，各入口仍要求对应的 URL 配置非空；开启开关不保证目标站点在当前网络可访问。
- 这是服务端站点配置，不是前端构建环境变量。调整后重新加载页面以获取配置；浏览器持久化缓存可能在请求完成前短暂保留旧状态。
- 新安装会初始化为 `"false"`；升级不会覆盖已有配置，也不需要为缺失配置迁移数据库。

## Getting Started

First, run the development server:

```bash
pnpm install
// or
pnpm i --registry=https://registry.npmmirror.com

// then
pnpm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

### File Tree:

```
.
├── README.md
├── components
│   ├── Header
│   │   └── index.tsx
│   └── Layout
│       ├── Basic.tsx
│       └── Function.tsx
├── constants
│   └── index.ts
├── locales
│   ├── en
│   │   └── message.js
│   └── zh-CN
│       └── message.js
├── next-env.d.ts
├── next.config.js
├── package.json
├── pages
│   ├── _app.tsx
│   ├── _document.tsx
│   ├── api
│   │   ├── app.ts
│   │   └── response.ts
│   ├── app
│   │   ├── [id]
│   │   │   ├── databases
│   │   │   │   └── index.tsx
│   │   │   ├── functions
│   │   │   │   ├── [function_id].tsx
│   │   │   │   ├── index.module.scss
│   │   │   │   ├── mockFuncTextString.tsx
│   │   │   │   ├── mods
│   │   │   │   │   ├── CreateModal
│   │   │   │   │   │   └── index.tsx
│   │   │   │   │   ├── DebugPannel
│   │   │   │   │   │   └── index.tsx
│   │   │   │   │   ├── DependecePanel
│   │   │   │   │   │   ├── index.module.scss
│   │   │   │   │   │   └── index.tsx
│   │   │   │   │   ├── FunctionPanel
│   │   │   │   │   │   ├── index.module.scss
│   │   │   │   │   │   └── index.tsx
│   │   │   │   │   └── List
│   │   │   │   │       └── index.tsx
│   │   │   │   └── store.ts
│   │   │   ├── index.tsx
│   │   │   ├── mods
│   │   │   │   └── SiderBar
│   │   │   │       ├── index.module.scss
│   │   │   │       └── index.tsx
│   │   │   └── storages
│   │   │       └── index.tsx
│   │   ├── index.tsx
│   │   └── mods
│   │       └── CrateDialog
│   │           └── index.tsx
│   ├── globals.css
│   ├── home
│   │   └── index.tsx
│   └── index.tsx
├── pnpm-lock.yaml
├── postcss.config.js
├── public
│   ├── favicon.ico
│   ├── logo.png
│   └── vercel.svg
├── tailwind.config.js
├── tsconfig.json
└── utils
    ├── i18n.ts
    └── request.ts
```

### Tech Stack：

- base: react / nextjs 12.x https://nextjs.org/docs/getting-started (will be update to 13.x)
- request: react-query + axios https://tanstack.com/query/v4/
- state mange: zustand + immer https://zustand-demo.pmnd.rs/
- i18n: lingui https://lingui.js.org/
- UI : chakra : https://chakra-ui.com/getting-started
- Style: tailwind + sass https://tailwindcss.com/
- Icon: react-icons: https://react-icons.github.io/react-icons

### DX:

- click-to-component https://github.com/ericclemmons/click-to-component
