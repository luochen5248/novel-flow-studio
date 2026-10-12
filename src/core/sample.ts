import type { EdgeKind, FlowGraph, StoryNode } from '@/types/graph'
import { createEdge, createGraph } from './model'
import { layoutTimeline } from './layout'

/**
 * 示例故事：《江雾渡》
 * 主线 8 节点 + 一条 lane=1 的支线（阿霁视角）+ 一条倒叙回指。
 * 用于空状态的「载入示例故事」，也是布局 / 导出 / AI 生图的现成靶子。
 */

interface Seed {
  id: string
  kind: StoryNode['kind']
  title: string
  timeLabel: string
  summary: string
  content: string
  characters: string[]
  location: string
  tags: string[]
  status: StoryNode['status']
  chapter: string
  lane: number
  order: number
}

const SEEDS: Seed[] = [
  {
    id: 's1',
    kind: 'milestone',
    title: '序章 · 雨夜渡口',
    timeLabel: '宣和三年 · 深秋',
    summary: '一场连下七日的秋雨，把渡口的石阶泡成了墨色。有人在雨里等一条不会来的船。',
    content:
      '雨下了七日。\n\n江面涨到石阶第三级，撑篙的老周把船缆系了三道，还是不放心。他蹲在棚下抽烟，看对岸的灯一盏一盏灭下去。\n\n「今晚不会有人过江了。」他说。\n\n可石阶上还坐着一个人，披着蓑衣，从黄昏坐到半夜。',
    characters: ['老周', '无名客'],
    location: '西岸渡口',
    tags: ['开篇', '雨'],
    status: 'done',
    chapter: '序章',
    lane: 0,
    order: 0
  },
  {
    id: 's2',
    kind: 'event',
    title: '第一章 · 老船工的账本',
    timeLabel: '宣和三年 · 十月初二',
    summary: '老周的账本记了三十年客人，唯独有一页被墨涂黑——那页的名字，他至死没提过。',
    content:
      '账本是线装的，纸页发脆。每一页左栏记日期，右栏记人名，末尾画一道杠，代表船钱已付。\n\n十月初二那一页，杠画到一半，墨迹晕开，像是被雨淋过，又像是被谁的手指反复摩挲。\n\n老周把那一页折了角，从此不再翻。',
    characters: ['老周'],
    location: '渡口棚屋',
    tags: ['悬疑', '账本'],
    status: 'done',
    chapter: '第一章',
    lane: 0,
    order: 1
  },
  {
    id: 's3',
    kind: 'scene',
    title: '第二章 · 江雾里的名字',
    timeLabel: '宣和三年 · 十月十一',
    summary: '雾起时，江心传来一声呼喊。阿霁听清了那个名字，却从此装作没听过。',
    content:
      '雾是从江心长出来的，一团一团，把船头船尾隔成两个世界。\n\n阿霁在船尾淘米，听见有人喊一个名字。那名字她认得——是她三年前离乡的哥哥。\n\n她把米盆放下，没有应声。雾散的时候，江面什么都没有。',
    characters: ['阿霁', '阿霁的哥哥'],
    location: '江心',
    tags: ['雾', '伏笔'],
    status: 'drafted',
    chapter: '第二章',
    lane: 0,
    order: 2
  },
  {
    id: 's4',
    kind: 'decision',
    title: '第三章 · 抉择：留下或离开',
    timeLabel: '宣和三年 · 十月十九',
    summary: '渡口要迁，官府给了三天。老周必须在沉掉账本和交出账本之间选一个。',
    content:
      '告示贴在棚屋的柱子上，墨还没干。\n\n「三日内迁毕，旧渡废。」\n\n老周坐在门槛上，手里捧着账本。交上去，那页黑墨会被人查；沉进江里，三十年的客人就都白记了。\n\n他把账本揣进怀里，走出门去。',
    characters: ['老周', '衙役'],
    location: '渡口棚屋',
    tags: ['抉择', '转折'],
    status: 'drafted',
    chapter: '第三章',
    lane: 0,
    order: 3
  },
  {
    id: 's5',
    kind: 'event',
    title: '第四章 · 三年后的回信',
    timeLabel: '宣和六年 · 春',
    summary: '一封没有署名的信从南岸寄来，只有八个字：船还在，人未归。',
    content:
      '信是托货郎捎来的，纸是南边产的竹纸，薄得透光。\n\n上面只有八个字，笔锋很急：\n\n「船还在，人未归。」\n\n阿霁把信压在陶罐底下，压了整整一个春天。',
    characters: ['阿霁'],
    location: '西岸 · 阿霁家',
    tags: ['时间跳跃', '信'],
    status: 'drafted',
    chapter: '第四章',
    lane: 0,
    order: 4
  },
  {
    id: 's6',
    kind: 'milestone',
    title: '第五章 · 桥塌之夜',
    timeLabel: '宣和六年 · 七月十五',
    summary: '新桥落成的当夜塌了半边。江面上漂着那只三十年没沉过的旧船。',
    content:
      '七月十五，新桥挂灯。整条江都被照成橘色。\n\n子时三刻，一声闷响，桥西第三墩裂了。人群往东跑，灯落进水里，一盏一盏灭。\n\n天亮时，人们在下游两里处捞起那只旧渡船。船底朝天，缆绳断口很新。',
    characters: ['老周', '阿霁'],
    location: '新桥',
    tags: ['高潮', '夜'],
    status: 'planned',
    chapter: '第五章',
    lane: 0,
    order: 5
  },
  {
    id: 's7',
    kind: 'scene',
    title: '第六章 · 渡口重修',
    timeLabel: '宣和七年 · 清明',
    summary: '新渡口立在旧址上游三百步。碑上没刻老周的名字，只刻了那页黑墨里藏着的两个字。',
    content:
      '清明前后，新渡口落成。石阶九级，比旧的多三级。\n\n碑是新凿的，字口很浅。碑上没写捐资者的名字，只刻了两个字——那两个字的笔画，和账本上被涂黑那页露出的残笔一模一样。\n\n阿霁站在碑前站了很久，然后转身去撑她的船。',
    characters: ['阿霁'],
    location: '新渡口',
    tags: ['收束', '碑'],
    status: 'planned',
    chapter: '第六章',
    lane: 0,
    order: 6
  },
  {
    id: 's8',
    kind: 'milestone',
    title: '尾声 · 江水东去',
    timeLabel: '宣和九年 · 秋',
    summary: '很多年后，渡口只剩一级石阶。撑船的人换了两代，江雾还是从江心长出来。',
    content:
      '很多年后，新渡口也旧了。石阶被水啃得只剩一级。\n\n撑船的换成了阿霁的侄孙。他不会记人名，只在船头挂一只陶罐，罐里压着一张薄得透光的纸。\n\n起雾的时候，他学着长辈的样子不出声。',
    characters: ['阿霁的侄孙'],
    location: '新渡口（旧址）',
    tags: ['尾声', '传承'],
    status: 'planned',
    chapter: '尾声',
    lane: 0,
    order: 7
  },
  {
    id: 'b1',
    kind: 'scene',
    title: '支线 · 阿霁离乡',
    timeLabel: '宣和元年 · 冬',
    summary: '阿霁十七岁那年坐船过江，从此把西岸的口音改掉了。',
    content:
      '她坐在船尾，抱着一只陶罐。罐里是母亲留下的两枚银簪。\n\n船到江心，她回头看了一眼西岸。岸上的灯只剩一盏，那是她哥哥在等她——可她没有下船。',
    characters: ['阿霁', '阿霁的哥哥'],
    location: '江心',
    tags: ['支线', '人物前史'],
    status: 'drafted',
    chapter: '支线一',
    lane: 1,
    order: 0
  },
  {
    id: 'b2',
    kind: 'event',
    title: '支线 · 南岸的当铺',
    timeLabel: '宣和四年 · 夏',
    summary: '她在南岸当掉一枚银簪，换回一张写着渡口旧址的舆图。',
    content:
      '当铺的柜台很高，掌柜只看东西不看人。\n\n一枚银簪，换了三两银子和一张旧舆图。图上用朱砂圈了一个点，旁边小字：旧渡。\n\n阿霁把图折成方块，塞进陶罐。',
    characters: ['阿霁', '当铺掌柜'],
    location: '南岸',
    tags: ['支线', '线索'],
    status: 'drafted',
    chapter: '支线二',
    lane: 1,
    order: 1
  },
  {
    id: 'b3',
    kind: 'event',
    title: '支线 · 归来',
    timeLabel: '宣和六年 · 七月十六',
    summary: '桥塌的第二天，阿霁撑着旧船回到西岸。她在碑前放下了那只陶罐。',
    content:
      '她撑船回来的时候，江面还漂着灯的碎木。\n\n船是旧的，篙是新的。她把船系在仅剩的那级石阶上，抱着陶罐上了岸。\n\n罐子放在碑前，没有打开。有些东西不必打开。',
    characters: ['阿霁'],
    location: '西岸旧址',
    tags: ['支线收束', '汇合'],
    status: 'planned',
    chapter: '支线三',
    lane: 1,
    order: 2
  }
]

const EDGE_SEEDS: Array<[string, string, EdgeKind, string?]> = [
  ['s1', 's2', 'flow'],
  ['s2', 's3', 'flow'],
  ['s3', 's4', 'flow'],
  ['s4', 's5', 'flow', '三年后'],
  ['s5', 's6', 'flow'],
  ['s6', 's7', 'flow'],
  ['s7', 's8', 'flow'],
  ['s2', 'b1', 'branch', '阿霁线'],
  ['b1', 'b2', 'flow'],
  ['b2', 'b3', 'flow'],
  ['b3', 's7', 'branch', '汇回主线'],
  ['s6', 's3', 'flashback', '回指 · 江雾']
]

const KIND_COLOR_SEED: Record<string, string> = {
  milestone: 'ink',
  event: 'teal',
  scene: 'mist',
  decision: 'gold',
  character: 'clay',
  note: 'sage'
}

export function createSampleGraph(name = '江雾渡 · 示例时间线'): FlowGraph {
  const graph = createGraph(name)
  graph.nodes = SEEDS.map((seed) => ({
    id: seed.id,
    kind: seed.kind,
    title: seed.title,
    timeLabel: seed.timeLabel,
    summary: seed.summary,
    content: seed.content,
    characters: [...seed.characters],
    location: seed.location,
    tags: [...seed.tags],
    status: seed.status,
    chapter: seed.chapter,
    color: KIND_COLOR_SEED[seed.kind] ?? 'teal',
    lane: seed.lane,
    x: 0,
    y: 0,
    w: 268,
    h: 132,
    order: seed.order
  }))
  graph.edges = EDGE_SEEDS.map(([source, target, kind, label]) =>
    createEdge(source, target, kind, label)
  )
  graph.settings.rowGap = 196
  graph.settings.laneGap = 340
  return layoutTimeline(graph)
}
