const assert = require('node:assert/strict')

// 模拟纯 JS 测试逻辑验证核心算法
function isModelSelectionQuestion(question) {
  if (!question.options || question.options.length === 0) return false
  const text = `${question.id} ${question.question}`.toLowerCase()
  const isModelQuery = /model|模型|codex|claude|gemini|gpt|subagent/i.test(text)
  const optionsLookLikeModels = question.options.some(opt =>
    /gpt|claude|sonnet|opus|haiku|gemini|deepseek|sol|terra|luna|astra|o1|o3|o4/i.test(opt.value)
  )
  return isModelQuery || optionsLookLikeModels
}

function test() {
  console.log('Testing model-strength logic...')
  assert.equal(
    isModelSelectionQuestion({
      id: 'codex_model',
      question: '请选择本次测试使用的模型：',
      options: [{ label: 'GPT-6.1-Sol', value: 'gpt-6.1-sol' }]
    }),
    true
  )

  assert.equal(
    isModelSelectionQuestion({
      id: 'general_question',
      question: '请确认是否继续',
      options: [{ label: '是', value: 'yes' }]
    }),
    false
  )

  console.log('All JS verification tests passed!')
}

test()
