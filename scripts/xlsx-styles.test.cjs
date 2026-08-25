const assert = require('node:assert/strict')
const {
  normalizeXlsxStyles
} = require('../node_modules/.cache/agentpet-xlsx-style-tests/xlsx-styles.js')

const rangeStyle = normalizeXlsxStyles([
  {
    range: 'A1:C2',
    bold: true,
    fill: '4472C4',
    color: 'FFFFFF',
    alignment: { horizontal: 'center', vertical: 'top', wrapText: true }
  }
])[0]
assert.deepEqual(
  [rangeStyle.startRow, rangeStyle.endRow, rangeStyle.startColumn, rangeStyle.endColumn],
  [1, 2, 1, 3]
)
assert.equal(rangeStyle.style.bgColor, '4472C4')
assert.equal(rangeStyle.style.fontColor, 'FFFFFF')
assert.equal(rangeStyle.style.align, 'center')
assert.equal(rangeStyle.style.valign, 'top')
assert.equal(rangeStyle.style.wrapText, true)

const legacyStyle = normalizeXlsxStyles({ A1: { bold: true, bgColor: '112233' } })[0]
assert.equal(legacyStyle.range, 'A1')
assert.equal(legacyStyle.style.bgColor, '112233')

assert.throws(() => normalizeXlsxStyles([{ bold: true }]), /styles\[0\] 缺少 range/)
assert.throws(() => normalizeXlsxStyles([{ range: '0', bold: true }]), /有效的 Excel 单元格或范围/)

console.log('xlsx style normalization tests passed')
