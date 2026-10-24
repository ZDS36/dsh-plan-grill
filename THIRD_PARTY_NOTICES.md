# 第三方来源与许可声明

## Grill Toolkit / grillme-skill

本插件的盘问方法及三模式提示词参考并改编自
[KAIXUAN-zhang-bot/grillme-skill](https://github.com/KAIXUAN-zhang-bot/grillme-skill)。
该项目的 README 声明，其内容进一步整合自
[mattpocock/skills](https://github.com/mattpocock/skills) 的 `grill-me`、`grilling`、
`grill-with-docs`、`domain-modeling` 和 `wayfinder`。

沿用的方法包括：沿决策树澄清依赖、一次只问一个问题、提供推荐答案和理由、
自行查明代码事实、将决策交给用户，以及达成共识后再执行。
模式 A 保留纯对话盘问；模式 B 使用术语表和 ADR；模式 C 使用决策地图和本地票据。
这些文档约定通过提示词交给模型执行，并非插件内置的文档生成器。

本项目在此基础上实现了适配 DeepSeek Harness 的 Host/Client 代码、输入框模式菜单、
会话状态、证据条目与路径版本核对，以及 `plan_grill_review` 计划评审交互。
本项目是独立适配项目；来源声明不表示原作者参与维护或提供官方背书。

## 核对来源

2026-10-24 核对上游提交
[`a1ff693e2cf5bdae1611731e7b3230c7bdbd55d1`](https://github.com/KAIXUAN-zhang-bot/grillme-skill/commit/a1ff693e2cf5bdae1611731e7b3230c7bdbd55d1)：

- [README.md](https://github.com/KAIXUAN-zhang-bot/grillme-skill/blob/a1ff693e2cf5bdae1611731e7b3230c7bdbd55d1/README.md)
- [SKILL.md](https://github.com/KAIXUAN-zhang-bot/grillme-skill/blob/a1ff693e2cf5bdae1611731e7b3230c7bdbd55d1/SKILL.md)
- [LICENSE](https://github.com/KAIXUAN-zhang-bot/grillme-skill/blob/a1ff693e2cf5bdae1611731e7b3230c7bdbd55d1/LICENSE)

该提交仅是本次来源核对快照，不代表本插件最初开发时引用的确切版本。

## 版权与许可

上游以 MIT License 发布，保留以下原始版权声明：

```text
Copyright (c) 2024 Matt Pocock
Copyright (c) 2026 KAIXUAN-zhang-bot
```

完整上游许可随本项目分发于 [LICENSES/grillme-skill-MIT.txt](LICENSES/grillme-skill-MIT.txt)。
本项目自有代码沿用仓库原有 [MIT License](LICENSE)，Copyright (c) 2026 ZDS36。
复制、修改或再分发上游内容或其重要部分时，应一并保留上述版权与完整许可。
