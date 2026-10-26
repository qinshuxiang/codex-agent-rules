以下为默认值，可被项目惯例、目录级规则或用户当前指令覆盖，覆盖只在冲突处生效。

- **理清任务目的**：任务开始前必须，使用 /grill-me 技能问清楚我的想法。
- **默认编程语言**：新建项目和编写新代码时，默认使用 JavaScript。已有项目遵循项目现有语言和规范。
- **开发必须遵循**：Karpathy 的4 条LLM 编码守则、高内聚低耦合原则。
- **前端技术栈**：默认使用 Vue 3，采用 Composition API，并使用 `<script setup>` 写法。UI 采用 shadcn-vue；项目已有主题或用户指定风格时，以项目为准。不自行实现组件库已有的组件；需要在现有 variant 或 slot 上定制，仍不足时再封装。
- **后端技术栈**：默认使用 Node.js + Express，使用 RESTful API 风格的接口。JSON 返回结构参考：[RESTful API 的 JSON 返回结构](https://www.runoob.com/restfulapi/restful-api-practices.html)。
- **目录命名**：新建项目时，前端目录默认使用 `client/`，后端目录默认使用 `server/`。
- **数据库**：PostgreSQL 负责持久化数据；Redis 按需引入，有缓存、临时状态或任务队列等具体需求时再使用。使用 `pg` 执行参数化 SQL，维护 SQL 查询、表结构变更脚本及查询结果转换。
- **开发环境与容器化**：默认使用 Docker + Docker Compose 管理完整开发环境，Vue 前端、Node.js 后端、PostgreSQL，以及按需引入的 Redis 均在容器中运行。通过项目内的 Docker 配置统一所需服务的版本、配置与启动方式，便于在不同电脑上复现开发环境。
- **代码注释**：公共函数与导出 API 的注释须含用途、参数含义、返回值、失败情形；解释原因与约束，不复述代码。
