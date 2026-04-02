# GitHub Interface Translator (Chinese)

一个面向 GitHub 网页端的 Tampermonkey 油猴脚本。  
它会将 GitHub 页面中的主要文案翻译为中文，同时尽量保持代码与文件名不被误翻，帮助你更快理解页面内容。

## 在线安装

- Greasy Fork 页面（推荐）：  
  [https://greasyfork.org/zh-CN/scripts/572158-github-interface-translator-chinese](https://greasyfork.org/zh-CN/scripts/572158-github-interface-translator-chinese)

## 功能特性

- 翻译 GitHub 页面主要可读内容（说明、按钮文案、描述文本等）
- 不翻译代码块、行内代码和代码视图
- 不翻译文件/文件夹名称区域
- 支持一键切换：`翻译页面` / `恢复原文`
- 支持 GitHub 页面内跳转（Turbo/PJAX）
- 对动态加载内容自动补翻
- 批量翻译 + 本地缓存，减少重复请求并提升速度

## 使用方式

1. 打开任意 GitHub 页面。
2. 点击右下角 `翻译页面` 按钮。
3. 再次点击可 `恢复原文`。

## Tampermonkey（油猴）安装教程

1. 先安装浏览器扩展 Tampermonkey：  
   [https://www.tampermonkey.net/](https://www.tampermonkey.net/)
2. 打开上面的 Greasy Fork 脚本页面。
3. 点击 `安装此脚本` 并确认安装。
4. 刷新 GitHub 页面后即可使用。

## 本仓库文件说明

- `github-readme-translator.user.js`：油猴脚本源码
- `README.md`：项目介绍与使用说明

## 技术说明

- 目前使用免费翻译接口 `translate.googleapis.com`。
- 脚本会尽量跳过代码和文件树区域，但 GitHub 页面结构持续变化，个别区域可能仍需后续规则优化。
- 如遇性能问题，可在脚本中将 `ENABLE_DYNAMIC_TRANSLATE` 设为 `false`，关闭动态补翻以降低负载。
