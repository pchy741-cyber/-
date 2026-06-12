/**
 * 테마 클러스터 — 주도주 급등 → 2차 가치주 동반 편입
 *
 * 원리:
 *   1. 테마 내 주도주가 +5% 이상 급등
 *   2. 같은 테마의 후행 종목(아직 +0.5~4% 수준)을 찾아 워치리스트 편입
 *   3. 이튿날~수일 내 주도주 상승 파급 스윙 공략
 *
 * source 태그: 'THEME_CLUSTER' — provisional score 62 주입으로 파이프라인 통과
 */

export interface ThemeCluster {
  id: string;
  name: string;
  stocks: { code: string; name: string }[];
}

export const THEME_CLUSTERS: ThemeCluster[] = [
  {
    id: 'SEMICON_EQUIP',
    name: '반도체 장비/소재',
    stocks: [
      { code: '042370', name: 'HPSP' },
      { code: '042700', name: '한미반도체' },
      { code: '319660', name: '피에스케이' },
      { code: '240810', name: '원익IPS' },
      { code: '039030', name: '이오테크닉스' },
      { code: '036930', name: '주성엔지니어링' },
      { code: '140860', name: '파크시스템스' },
      { code: '357780', name: '솔브레인' },
      { code: '005290', name: '동진쎄미켐' },
      { code: '104830', name: '원익머트리얼즈' },
      { code: '403870', name: '한양이엔지' },
      { code: '058470', name: '리노공업' },
    ],
  },
  {
    id: 'SEMICON_BIG',
    name: '반도체 대형',
    stocks: [
      { code: '005930', name: '삼성전자' },
      { code: '000660', name: 'SK하이닉스' },
      { code: '042700', name: '한미반도체' },
      { code: '058470', name: '리노공업' },
      { code: '336370', name: '솔브레인홀딩스' },
    ],
  },
  {
    id: 'DEFENSE',
    name: '방산',
    stocks: [
      { code: '012450', name: '한화에어로스페이스' },
      { code: '064350', name: '현대로템' },
      { code: '079550', name: 'LIG넥스원' },
      { code: '272210', name: '한화시스템' },
      { code: '042660', name: '한화오션' },
      { code: '047050', name: '포스코인터내셔널' },
      { code: '065450', name: '빅텍' },
      { code: '000880', name: '한화' },
    ],
  },
  {
    id: 'BATTERY_MATERIAL',
    name: '2차전지 소재',
    stocks: [
      { code: '086520', name: '에코프로' },
      { code: '247540', name: '에코프로비엠' },
      { code: '003670', name: '포스코퓨처엠' },
      { code: '066970', name: '엘앤에프' },
      { code: '278280', name: '천보' },
      { code: '005070', name: '코스모신소재' },
      { code: '006400', name: '삼성SDI' },
      { code: '373220', name: 'LG에너지솔루션' },
    ],
  },
  {
    id: 'BATTERY_EQUIP',
    name: '2차전지 장비',
    stocks: [
      { code: '222080', name: '씨아이에스' },
      { code: '217820', name: '엔에스' },
      { code: '348210', name: '넥스틴' },
      { code: '299030', name: '하나기술' },
      { code: '071280', name: '로체시스템즈' },
    ],
  },
  {
    id: 'POWER_NUCLEAR',
    name: '전력/원전',
    stocks: [
      { code: '034020', name: '두산에너빌리티' },
      { code: '298040', name: '효성중공업' },
      { code: '010120', name: 'LS일렉트릭' },
      { code: '267260', name: '현대일렉트릭' },
      { code: '082740', name: '한국전력기술' },
      { code: '015760', name: '한국전력' },
      { code: '071970', name: '스틸플라워' },
    ],
  },
  {
    id: 'SHIPBUILDING',
    name: '조선/해운',
    stocks: [
      { code: '009540', name: 'HD현대중공업' },
      { code: '042660', name: '한화오션' },
      { code: '010140', name: '삼성중공업' },
      { code: '329180', name: 'HD현대' },
      { code: '011200', name: 'HMM' },
      { code: '028670', name: '팬오션' },
    ],
  },
  {
    id: 'BIO_PHARMA',
    name: '바이오/제약',
    stocks: [
      { code: '000100', name: '유한양행' },
      { code: '207940', name: '삼성바이오로직스' },
      { code: '068270', name: '셀트리온' },
      { code: '128940', name: '한미약품' },
      { code: '196170', name: '알테오젠' },
      { code: '170900', name: '동아ST' },
    ],
  },
  {
    id: 'AUTO',
    name: '자동차/부품',
    stocks: [
      { code: '005380', name: '현대차' },
      { code: '000270', name: '기아' },
      { code: '012330', name: '현대모비스' },
      { code: '060980', name: '한온시스템' },
      { code: '161390', name: '한국타이어앤테크놀로지' },
      { code: '204320', name: '만도' },
    ],
  },
  {
    id: 'STEEL_MATERIAL',
    name: '철강/소재',
    stocks: [
      { code: '005490', name: 'POSCO홀딩스' },
      { code: '004020', name: '현대제철' },
      { code: '010060', name: 'OCI홀딩스' },
      { code: '047050', name: '포스코인터내셔널' },
      { code: '001440', name: '대한전선' },
    ],
  },
  {
    id: 'CHEMICAL_HWASUNG',
    name: '화학/후성',
    stocks: [
      { code: '093370', name: '후성' },
      { code: '011170', name: '롯데케미칼' },
      { code: '051910', name: 'LG화학' },
      { code: '009830', name: '한화솔루션' },
      { code: '004000', name: '롯데정밀화학' },
      { code: '025000', name: 'KPX홀딩스' },
    ],
  },
];

// 빠른 조회: stock_code → 속한 모든 클러스터
const _codeToCluster = new Map<string, ThemeCluster[]>();
for (const cluster of THEME_CLUSTERS) {
  for (const s of cluster.stocks) {
    const existing = _codeToCluster.get(s.code) ?? [];
    existing.push(cluster);
    _codeToCluster.set(s.code, existing);
  }
}

/**
 * surgedCode가 속한 테마 클러스터에서 함께 편입할 후행 종목 목록 반환
 * - 이미 워치리스트에 있는 종목 제외
 * - surgedCode 본인 제외
 */
export function getClusterFollowers(
  surgedCode: string,
  activeWatchlistCodes: Set<string>,
): { code: string; name: string; clusterId: string; clusterName: string }[] {
  const clusters = _codeToCluster.get(surgedCode);
  if (!clusters || clusters.length === 0) return [];

  const result: { code: string; name: string; clusterId: string; clusterName: string }[] = [];
  const added = new Set<string>();

  for (const cluster of clusters) {
    for (const stock of cluster.stocks) {
      if (stock.code === surgedCode) continue;
      if (activeWatchlistCodes.has(stock.code)) continue;
      if (added.has(stock.code)) continue;
      added.add(stock.code);
      result.push({
        code: stock.code,
        name: stock.name,
        clusterId: cluster.id,
        clusterName: cluster.name,
      });
    }
  }

  return result;
}
