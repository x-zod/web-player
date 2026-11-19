# Static IPTV Player
纯静态 IPTV HLS 播放器，托管于 Cloudflare Pages，关联 GitHub 仓库自动部署。
> 无后端、无 Worker、无需 KV，仅两个静态文件。访客只能选择分组和频道播放，**无法编辑、新增频道源**。

## 功能特性
- 自动解析标准 `m3u` 文件，识别 `group-title` 生成分组 + 频道二级菜单
- 三栏布局：分组列表｜频道列表｜播放器
- 基于 hls.js 播放 m3u8 流，原生浏览器支持
- 深色风格，移动端自适应
- 自动部署：修改 `index.html` / `tv.m3u` 提交 GitHub 后，Cloudflare Pages 自动更新

## 项目文件结构
├── index.html    # 播放器主页面
├── tv.m3u        # IPTV节目清单
└── README.md     # 项目说明
