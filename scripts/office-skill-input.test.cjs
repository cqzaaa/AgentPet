const assert = require('node:assert/strict')
const {
  parseOfficeSkillInput,
  repairUnescapedJsonQuotes
} = require('../node_modules/.cache/agentpet-office-input-tests/parse-input.js')

assert.deepEqual(parseOfficeSkillInput({ output_name: 'output.xlsx' }), {
  output_name: 'output.xlsx'
})
assert.deepEqual(parseOfficeSkillInput('{"output_name":"output.xlsx"}'), {
  output_name: 'output.xlsx'
})

const malformed = '{"content":{"data":[["在"已订业务"页面","全国"亲情网"页面"]]}}'
const repaired = repairUnescapedJsonQuotes(malformed)
assert.deepEqual(JSON.parse(repaired), {
  content: { data: [['在"已订业务"页面', '全国"亲情网"页面']] }
})
assert.deepEqual(parseOfficeSkillInput(malformed), {
  content: { data: [['在"已订业务"页面', '全国"亲情网"页面']] }
})

assert.throws(() => parseOfficeSkillInput('not json'), /input 字符串不是有效的 JSON 对象/)
assert.throws(() => parseOfficeSkillInput('[]'), /解析结果不是对象|不是有效的 JSON 对象/)

console.log('office skill input parsing tests passed')
