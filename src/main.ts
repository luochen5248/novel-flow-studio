import { createApp } from 'vue'
import { createPinia } from 'pinia'
import Antd from 'ant-design-vue'
import App from './App.vue'
import './styles/global.css'
import 'ant-design-vue/dist/reset.css'
import './styles/polish.css'

// 副作用导入：挂载 window.NovelFlow（AI / 控制台可编程 API），不修改 aiApi.ts 本身
import './api/aiApi'

const app = createApp(App)
app.use(createPinia())
app.use(Antd)
app.mount('#app')

// 清掉 index.html 里的启动占位
document.getElementById('boot-splash')?.remove()
