/** 轻量 id 生成：不引入 uuid，避免额外依赖 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

function randomPart(len: number): string {
  let out = ''
  for (let i = 0; i < len; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  }
  return out
}

let counter = 0

/** 单调递增的本地序号，保证同一毫秒内不撞车 */
function seq(): string {
  counter = (counter + 1) % 1_000_000
  return counter.toString(36).padStart(4, '0')
}

export function uid(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}${seq()}${randomPart(4)}`
}

export const nodeId = (): string => uid('n')
export const edgeId = (): string => uid('e')
export const graphId = (): string => uid('g')
