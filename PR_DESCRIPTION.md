本次变更用于支持 OpenAI 兼容的视频生成能力，面向 issue-10 的格式与能力接入需求。
主要改动包括新增 OpenAI 视频 provider 实现，补充 provider 工厂中的接入与路由逻辑，扩展模型能力上限配置，并在设置页面表单中增加对应的配置项与交互支持。
核心新增文件为 src/lib/ai/providers/openai-video.ts，同时联动修改了 src/lib/ai/provider-factory.ts、src/lib/ai/model-limits.ts 和 src/components/settings/provider-form.tsx。
本次描述已按要求改为中文纯文本格式，不使用 Markdown 标题、列表或代码标记。
