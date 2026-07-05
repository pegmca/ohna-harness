import type { DataSourceIngestRequestDto } from "@aiagent/types";
import { createDataSourceRuntime, type DataSourceRuntime } from "@aiagent/rag";
import type { RagEvalCase } from "./types.js";

/**
 * Demo 文档集合，覆盖银行年报、季报、公告和行业研究四类常见金融文本。
 *
 * 这些文档只用于本地 eval 和 demo，不引用真实公司机密数据；
 * 所有数字和表述均为教学用 mock 内容。
 */
export const DEMO_DOCUMENTS: DataSourceIngestRequestDto[] = [
  {
    source: "demo/annual-report",
    fileName: "pingan-bank-2024-annual-report.md",
    contentType: "text/markdown",
    content: `# 平安银行股份有限公司 2024 年年度报告摘要

## 资产质量
截至 2024 年末，本集团不良贷款率为 1.05%，较上年末下降 0.01 个百分点。关注类贷款占比 1.32%，逾期 90 天以上贷款与不良贷款比例保持在 0.78 的较低水平。对公贷款不良率为 0.80%，零售贷款不良率为 1.18%。本行持续优化授信准入标准，强化大额风险暴露管理，资产质量整体保持稳定。

## 盈利能力
2024 年，本集团实现营业收入 1646 亿元，同比下降 3.2%；归属于股东的净利润 397 亿元，同比增长 2.1%。基本每股收益 1.96 元，加权平均净资产收益率（ROE）为 10.5%，同比下降 0.4 个百分点。净息差 2.31%，同比下降 12 个基点。

## 资本充足
截至报告期末，本集团核心一级资本充足率为 9.2%，一级资本充足率为 10.6%，资本充足率为 13.5%，均满足监管要求。本行通过利润留存和发行二级资本债补充资本，资本缓冲充足。

## 经营情况
2024 年，本行持续推进零售转型，零售客户数突破 1.2 亿户，管理零售客户资产（AUM）超过 3.8 万亿元。对公业务聚焦战略性新兴产业、绿色金融和普惠金融。董事会建议每股派发现金股利 0.50 元，现金分红比例约 20%。
`
  },
  {
    source: "demo/quarterly-report",
    fileName: "catl-2024-q3-report.md",
    contentType: "text/markdown",
    content: `# 宁德时代新能源科技股份有限公司 2024 年第三季度报告摘要

## 营收与净利润
2024 年前三季度，公司实现营业收入 2590 亿元，同比下降 12.1%；归属于上市公司股东的净利润 360 亿元，同比增长 15.0%。其中第三季度单季净利润 131 亿元，环比增长 6.2%。

## 毛利率
受益于原材料价格下降和规模效应，公司前三季度综合毛利率为 25.1%，同比提升 2.3 个百分点。动力电池业务毛利率 24.5%，储能电池业务毛利率 28.0%。

## 海外市场
前三季度海外收入约 906 亿元，占总收入比重约 35%。欧洲和北美市场出货量保持增长，公司在匈牙利、德国等地布局产能以满足本地化供应需求。

## 研发投入
公司持续加大研发投入，前三季度研发费用约 180 亿元，占营业收入比例为 6.9%。重点投向固态电池、钠离子电池、麒麟电池和神行电池等下一代产品平台。

## 市场地位
根据第三方统计，2024 年上半年公司动力电池全球市占率为 37%，储能电池全球市占率为 40%，均位居全球第一。主要客户包括特斯拉、宝马、奔驰、理想、蔚来等国内外主流车企。

## 产能扩张
报告期内，公司新增产能约 100GWh，总产能超过 500GWh。新增产能主要分布在福建、四川、江苏以及匈牙利生产基地。
`
  },
  {
    source: "demo/announcement",
    fileName: "cmb-asset-quality-announcement.md",
    contentType: "text/markdown",
    content: `# 招商银行股份有限公司关于 2024 年一季度资产质量的公告

## 不良率
截至 2024 年 3 月末，本集团不良贷款率为 0.95%，较上年末下降 0.01 个百分点。其中，公司贷款不良率为 0.82%，零售贷款不良率为 1.05%。

## 拨备覆盖率
本集团贷款减值准备余额充足，拨备覆盖率为 450%，较上年末提升 5 个百分点。拨贷比为 4.28%，风险抵补充足。

## 关注类贷款
关注类贷款占比为 1.20%，较上年末下降 0.03 个百分点。关注类贷款迁徙率保持在较低水平，潜在风险总体可控。

## 资产质量趋势
本行坚持稳健的风险偏好，持续优化信贷结构，资产质量呈现稳中向好的态势。大额风险客户处置有序推进，新生成不良贷款率处于行业较低水平。

## 房地产行业风险
本行房地产贷款集中度较低，对公房地产贷款不良率为 3.85%，较年初下降 0.15 个百分点。房地产风险敞口总体可控，拨备计提充分。
`
  },
  {
    source: "demo/industry-report",
    fileName: "new-energy-vehicle-industry-2024.md",
    contentType: "text/markdown",
    content: `# 2024 年全球新能源汽车行业研究报告

## 市场规模
2024 年全球新能源汽车销量预计达到 1700 万辆，同比增长约 25%。中国市场销量约 1100 万辆，占全球销量比重超过 65%。

## 渗透率
2024 年中国新能源汽车渗透率预计达到 40%，较上年提升约 6 个百分点。欧洲市场渗透率约为 25%，北美市场渗透率约为 18%。

## 竞争格局
行业竞争加剧，市场份额向头部企业集中。全球动力电池前五大企业市占率合计超过 80%，中国企业在全球供应链中占据主导地位。

## 政策支持
主要经济体继续出台新能源汽车支持政策。中国延续新能源汽车购置税减免政策，推出以旧换新补贴；欧洲强化碳排放法规；美国通过通胀削减法案（IRA）提供税收抵免。

## 风险提示
行业面临原材料价格波动、地缘政治导致的供应链扰动、部分国家补贴退坡以及传统车企电动化转型加速带来的竞争压力。投资者需关注企业盈利能力和现金流状况。
`
  }
];

/**
 * 30 条 RAG eval case，覆盖 retrieval、correctness、faithfulness 和 citation coverage。
 *
 * 设计原则：
 * - 每个 case 都指定 `requiredSources` 和 `expectedKeywords`，确保 retrieval 和 correctness 可解释。
 * - `minCitations` 统一设为 1，要求答案至少提供一条引用。
 * - 标签按文档来源和主题分组，便于后续按维度统计。
 */
export const RAG_EVAL_CASES: RagEvalCase[] = [
  // 平安银行年报（10 条）
  {
    id: "rag_eval_001",
    question: "平安银行2024年不良贷款率是多少？",
    expectedAnswer: "平安银行2024年末不良贷款率为1.05%。",
    expectedKeywords: ["不良贷款率", "1.05%"],
    requiredSources: ["demo/annual-report"],
    minCitations: 1,
    tags: ["annual_report", "asset_quality", "pingan"]
  },
  {
    id: "rag_eval_002",
    question: "平安银行2024年拨备覆盖率变化如何？",
    expectedAnswer: "拨备覆盖率保持在较高水平，风险抵补充足。",
    expectedKeywords: ["拨备覆盖率", "290%"],
    requiredSources: ["demo/annual-report"],
    minCitations: 1,
    tags: ["annual_report", "asset_quality", "pingan"]
  },
  {
    id: "rag_eval_003",
    question: "平安银行2024年净利润同比变化多少？",
    expectedAnswer: "2024年归属于股东的净利润397亿元，同比增长2.1%。",
    expectedKeywords: ["净利润", "同比增长", "2.1%"],
    requiredSources: ["demo/annual-report"],
    minCitations: 1,
    tags: ["annual_report", "profitability", "pingan"]
  },
  {
    id: "rag_eval_004",
    question: "平安银行2024年ROE是多少？",
    expectedAnswer: "加权平均净资产收益率（ROE）为10.5%。",
    expectedKeywords: ["ROE", "10.5%"],
    requiredSources: ["demo/annual-report"],
    minCitations: 1,
    tags: ["annual_report", "profitability", "pingan"]
  },
  {
    id: "rag_eval_005",
    question: "平安银行2024年营业收入是多少？",
    expectedAnswer: "2024年营业收入1646亿元。",
    expectedKeywords: ["营业收入", "1646亿元"],
    requiredSources: ["demo/annual-report"],
    minCitations: 1,
    tags: ["annual_report", "profitability", "pingan"]
  },
  {
    id: "rag_eval_006",
    question: "平安银行资本充足率水平如何？",
    expectedAnswer: "资本充足率为13.5%，满足监管要求。",
    expectedKeywords: ["资本充足率", "13.5%"],
    requiredSources: ["demo/annual-report"],
    minCitations: 1,
    tags: ["annual_report", "capital", "pingan"]
  },
  {
    id: "rag_eval_007",
    question: "平安银行2024年资产质量总体评价如何？",
    expectedAnswer: "资产质量整体保持稳定，不良率下降。",
    expectedKeywords: ["资产质量", "稳定", "不良率"],
    requiredSources: ["demo/annual-report"],
    minCitations: 1,
    tags: ["annual_report", "asset_quality", "pingan"]
  },
  {
    id: "rag_eval_008",
    question: "平安银行2024年零售业务表现如何？",
    expectedAnswer: "零售客户数突破1.2亿户，AUM超过3.8万亿元。",
    expectedKeywords: ["零售业务", "AUM", "3.8万亿"],
    requiredSources: ["demo/annual-report"],
    minCitations: 1,
    tags: ["annual_report", "retail", "pingan"]
  },
  {
    id: "rag_eval_009",
    question: "平安银行对公贷款不良率是多少？",
    expectedAnswer: "对公贷款不良率为0.80%。",
    expectedKeywords: ["对公贷款", "不良率", "0.8%"],
    requiredSources: ["demo/annual-report"],
    minCitations: 1,
    tags: ["annual_report", "asset_quality", "pingan"]
  },
  {
    id: "rag_eval_010",
    question: "平安银行2024年分红情况如何？",
    expectedAnswer: "每股派发现金股利0.50元，现金分红比例约20%。",
    expectedKeywords: ["分红", "0.50元", "20%"],
    requiredSources: ["demo/annual-report"],
    minCitations: 1,
    tags: ["annual_report", "dividend", "pingan"]
  },

  // 宁德时代三季报（10 条）
  {
    id: "rag_eval_011",
    question: "宁德时代2024年前三季度营收是多少？",
    expectedAnswer: "前三季度实现营业收入2590亿元。",
    expectedKeywords: ["营收", "2590亿元"],
    requiredSources: ["demo/quarterly-report"],
    minCitations: 1,
    tags: ["quarterly_report", "revenue", "catl"]
  },
  {
    id: "rag_eval_012",
    question: "宁德时代2024年前三季度净利润是多少？",
    expectedAnswer: "归属于上市公司股东的净利润360亿元。",
    expectedKeywords: ["净利润", "360亿元"],
    requiredSources: ["demo/quarterly-report"],
    minCitations: 1,
    tags: ["quarterly_report", "profit", "catl"]
  },
  {
    id: "rag_eval_013",
    question: "宁德时代2024年毛利率变化如何？",
    expectedAnswer: "前三季度综合毛利率为25.1%，同比提升2.3个百分点。",
    expectedKeywords: ["毛利率", "25.1%"],
    requiredSources: ["demo/quarterly-report"],
    minCitations: 1,
    tags: ["quarterly_report", "margin", "catl"]
  },
  {
    id: "rag_eval_014",
    question: "宁德时代海外收入占比多少？",
    expectedAnswer: "海外收入约906亿元，占总收入比重约35%。",
    expectedKeywords: ["海外收入", "35%"],
    requiredSources: ["demo/quarterly-report"],
    minCitations: 1,
    tags: ["quarterly_report", "overseas", "catl"]
  },
  {
    id: "rag_eval_015",
    question: "宁德时代2024年前三季度研发投入多少？",
    expectedAnswer: "前三季度研发费用约180亿元。",
    expectedKeywords: ["研发投入", "180亿元"],
    requiredSources: ["demo/quarterly-report"],
    minCitations: 1,
    tags: ["quarterly_report", "rd", "catl"]
  },
  {
    id: "rag_eval_016",
    question: "宁德时代动力电池全球市占率是多少？",
    expectedAnswer: "动力电池全球市占率为37%，位居全球第一。",
    expectedKeywords: ["动力电池", "市占率", "37%"],
    requiredSources: ["demo/quarterly-report"],
    minCitations: 1,
    tags: ["quarterly_report", "market_share", "catl"]
  },
  {
    id: "rag_eval_017",
    question: "宁德时代储能电池业务增长如何？",
    expectedAnswer: "储能电池业务毛利率28.0%，业务保持快速增长。",
    expectedKeywords: ["储能电池", "增长", "28.0%"],
    requiredSources: ["demo/quarterly-report"],
    minCitations: 1,
    tags: ["quarterly_report", "storage", "catl"]
  },
  {
    id: "rag_eval_018",
    question: "宁德时代2024年前三季度净利润同比增速是多少？",
    expectedAnswer: "归属于上市公司股东的净利润同比增长15.0%。",
    expectedKeywords: ["净利润", "同比增长", "15.0%"],
    requiredSources: ["demo/quarterly-report"],
    minCitations: 1,
    tags: ["quarterly_report", "profit", "catl"]
  },
  {
    id: "rag_eval_019",
    question: "宁德时代主要客户有哪些？",
    expectedAnswer: "主要客户包括特斯拉、宝马、奔驰、理想、蔚来等。",
    expectedKeywords: ["客户", "特斯拉", "宝马"],
    requiredSources: ["demo/quarterly-report"],
    minCitations: 1,
    tags: ["quarterly_report", "customers", "catl"]
  },
  {
    id: "rag_eval_020",
    question: "宁德时代产能扩张情况如何？",
    expectedAnswer: "报告期内新增产能约100GWh，总产能超过500GWh。",
    expectedKeywords: ["产能", "扩张", "100GWh"],
    requiredSources: ["demo/quarterly-report"],
    minCitations: 1,
    tags: ["quarterly_report", "capacity", "catl"]
  },

  // 招商银行资产质量公告（5 条）
  {
    id: "rag_eval_021",
    question: "招商银行2024年一季度不良率是多少？",
    expectedAnswer: "2024年3月末不良贷款率为0.95%。",
    expectedKeywords: ["不良率", "0.95%"],
    requiredSources: ["demo/announcement"],
    minCitations: 1,
    tags: ["announcement", "asset_quality", "cmb"]
  },
  {
    id: "rag_eval_022",
    question: "招商银行拨备覆盖率是多少？",
    expectedAnswer: "拨备覆盖率为450%。",
    expectedKeywords: ["拨备覆盖率", "450%"],
    requiredSources: ["demo/announcement"],
    minCitations: 1,
    tags: ["announcement", "provision", "cmb"]
  },
  {
    id: "rag_eval_023",
    question: "招商银行关注类贷款占比多少？",
    expectedAnswer: "关注类贷款占比为1.20%。",
    expectedKeywords: ["关注类贷款", "1.20%"],
    requiredSources: ["demo/announcement"],
    minCitations: 1,
    tags: ["announcement", "asset_quality", "cmb"]
  },
  {
    id: "rag_eval_024",
    question: "招商银行资产质量趋势如何？",
    expectedAnswer: "资产质量呈现稳中向好的态势。",
    expectedKeywords: ["资产质量", "稳中向好"],
    requiredSources: ["demo/announcement"],
    minCitations: 1,
    tags: ["announcement", "asset_quality", "cmb"]
  },
  {
    id: "rag_eval_025",
    question: "招商银行房地产行业贷款风险如何？",
    expectedAnswer: "房地产风险敞口总体可控，拨备计提充分。",
    expectedKeywords: ["房地产", "风险", "可控"],
    requiredSources: ["demo/announcement"],
    minCitations: 1,
    tags: ["announcement", "real_estate", "cmb"]
  },

  // 新能源行业研究报告（5 条）
  {
    id: "rag_eval_026",
    question: "2024年全球新能源汽车销量预计多少？",
    expectedAnswer: "2024年全球新能源汽车销量预计达到1700万辆。",
    expectedKeywords: ["销量", "1700万辆"],
    requiredSources: ["demo/industry-report"],
    minCitations: 1,
    tags: ["industry_report", "market_size", "nev"]
  },
  {
    id: "rag_eval_027",
    question: "中国新能源汽车渗透率预计多少？",
    expectedAnswer: "中国新能源汽车渗透率预计达到40%。",
    expectedKeywords: ["渗透率", "40%"],
    requiredSources: ["demo/industry-report"],
    minCitations: 1,
    tags: ["industry_report", "penetration", "nev"]
  },
  {
    id: "rag_eval_028",
    question: "新能源汽车行业主要风险有哪些？",
    expectedAnswer: "面临原材料价格波动、供应链扰动、补贴退坡和竞争压力。",
    expectedKeywords: ["风险", "原材料", "价格波动"],
    requiredSources: ["demo/industry-report"],
    minCitations: 1,
    tags: ["industry_report", "risk", "nev"]
  },
  {
    id: "rag_eval_029",
    question: "新能源汽车政策支持有哪些？",
    expectedAnswer: "中国延续购置税减免、推出以旧换新补贴；欧洲强化碳排放法规；美国通过IRA提供税收抵免。",
    expectedKeywords: ["政策", "补贴", "购置税"],
    requiredSources: ["demo/industry-report"],
    minCitations: 1,
    tags: ["industry_report", "policy", "nev"]
  },
  {
    id: "rag_eval_030",
    question: "新能源汽车行业竞争格局如何？",
    expectedAnswer: "市场份额向头部企业集中，中国企业占据主导地位。",
    expectedKeywords: ["竞争格局", "头部集中"],
    requiredSources: ["demo/industry-report"],
    minCitations: 1,
    tags: ["industry_report", "competition", "nev"]
  }
];

/**
 * 创建已加载 demo 文档的内存 RAG runtime，供 eval runner 使用。
 *
 * @returns 已 ingest 全部 demo 文档的 runtime。
 */
export async function createDemoRagRuntime(): Promise<DataSourceRuntime> {
  const runtime = createDataSourceRuntime();

  for (const document of DEMO_DOCUMENTS) {
    const result = await runtime.ingest(document);

    if (!result.ok) {
      throw new Error(`ingest demo document failed: ${result.error.message}`);
    }
  }

  return runtime;
}
