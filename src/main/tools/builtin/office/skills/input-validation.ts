/* eslint-disable @typescript-eslint/no-explicit-any */

export function validateOfficeSkillInput(value: any, schema: any, path = 'input'): void {
  if (!schema || typeof schema !== 'object') return

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    throw new Error(`${path} 必须是以下值之一：${schema.enum.join(', ')}`)
  }

  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${path} 必须是对象`)
    }
    const properties = schema.properties && typeof schema.properties === 'object'
      ? schema.properties
      : null
    if (properties) {
      const unknownKeys = Object.keys(value).filter(key => !(key in properties))
      if (unknownKeys.length > 0) {
        throw new Error(`${path} 包含未知参数：${unknownKeys.join(', ')}；允许参数：${Object.keys(properties).join(', ')}`)
      }
    }
    for (const requiredKey of schema.required || []) {
      if (value[requiredKey] === undefined || value[requiredKey] === null) {
        throw new Error(`${path}.${requiredKey} 是必填参数`)
      }
    }
    if (typeof schema.minProperties === 'number' && Object.keys(value).length < schema.minProperties) {
      throw new Error(`${path} 至少需要 ${schema.minProperties} 个属性`)
    }
    for (const [key, childSchema] of Object.entries(properties || {})) {
      if (value[key] !== undefined) validateOfficeSkillInput(value[key], childSchema, `${path}.${key}`)
    }
    return
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path} 必须是数组`)
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      throw new Error(`${path} 至少需要 ${schema.minItems} 项`)
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      throw new Error(`${path} 最多允许 ${schema.maxItems} 项`)
    }
    value.forEach((item, index) => validateOfficeSkillInput(item, schema.items, `${path}[${index}]`))
    return
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new Error(`${path} 必须是字符串`)
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      throw new Error(`${path} 长度不能小于 ${schema.minLength}`)
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      throw new Error(`${path} 格式不正确`)
    }
  }

  if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${path} 必须是有限数值`)
    }
    if (schema.integer && !Number.isInteger(value)) throw new Error(`${path} 必须是整数`)
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      throw new Error(`${path} 不能小于 ${schema.minimum}`)
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      throw new Error(`${path} 不能大于 ${schema.maximum}`)
    }
  }

  if (schema.type === 'boolean' && typeof value !== 'boolean') {
    throw new Error(`${path} 必须是布尔值`)
  }
}
