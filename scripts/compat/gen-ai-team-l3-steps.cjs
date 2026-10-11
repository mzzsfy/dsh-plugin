// 生成 l3 步骤文件(避免 shell 转义/BOM)
const fs = require('fs')
const live = JSON.parse(fs.readFileSync('.compat/0.2.0-rc.2/live.json', 'utf8'))
const clickTeam = "[...document.querySelectorAll('button,a,[role=button],li,span,div')].filter(e=>e.childElementCount===0&&e.textContent.trim()==='AI 团队').pop()?.click() ?? 'not-found'"
const steps = {
  url: `http://127.0.0.1:${live.port}/?token=${live.token}`,
  out: '.compat/0.2.0-rc.2/ai-team-l3.json',
  steps: [
    { name: 'load', goto: '/' },
    { name: 'wait', wait: 5000 },
    { name: 'click-team', eval: clickTeam },
    { name: 'wait2', wait: 3000 },
    { name: 'panel', eval: 'document.body.innerText.slice(0, 1200)' },
    { name: 'shot', shot: '.compat/0.2.0-rc.2/ai-team-panel.png' },
  ],
}
fs.writeFileSync('.compat/0.2.0-rc.2/ai-team-l3-steps.json', JSON.stringify(steps, null, 1))
