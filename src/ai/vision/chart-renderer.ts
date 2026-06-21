/**
 * 캔들스틱 차트 PNG 렌더러
 *
 * OHLCV 데이터 → 캔들스틱 + 거래량 + MA5/MA20 차트 이미지
 * @napi-rs/canvas 사용 (Rust 기반, 시스템 의존성 없음)
 */

import { createCanvas } from '@napi-rs/canvas';
import { sma } from '../../analysis/moving-averages.js';
import type { DailyCandle } from '../../kis/market.js';

export interface ChartRenderOptions {
  width?: number;
  height?: number;
  maxCandles?: number;
  stockCode?: string;
}

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 500;
const DEFAULT_MAX_CANDLES = 60;

const COLOR = {
  bg: '#1a1a2e',
  gridLine: '#2a2a3e',
  textLight: '#aaaacc',
  bullCandle: '#26a69a',
  bearCandle: '#ef5350',
  bullVolume: 'rgba(38,166,154,0.4)',
  bearVolume: 'rgba(239,83,80,0.4)',
  ma5: '#42a5f5',
  ma20: '#ffa726',
  wick: '#888888',
};

export function renderCandlestickChart(
  candles: DailyCandle[],
  opts?: ChartRenderOptions,
): Buffer {
  const width = opts?.width ?? DEFAULT_WIDTH;
  const height = opts?.height ?? DEFAULT_HEIGHT;
  const maxCandles = opts?.maxCandles ?? DEFAULT_MAX_CANDLES;
  const stockCode = opts?.stockCode ?? '';

  // 최근 N봉만 사용, 날짜 오름차순 정렬
  const sorted = [...candles]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-maxCandles);

  if (sorted.length < 5) {
    throw new Error(`캔들 부족: ${sorted.length}개`);
  }

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // 레이아웃: 상단 패딩 30, 캔들 영역 65%, 갭 5%, 거래량 영역 25%, 하단 5%
  const padTop = 30;
  const padBottom = 25;
  const padLeft = 60;
  const padRight = 15;
  const chartW = width - padLeft - padRight;
  const totalChartH = height - padTop - padBottom;
  const candleAreaH = totalChartH * 0.65;
  const volumeAreaH = totalChartH * 0.25;
  const gapH = totalChartH * 0.05;
  const candleAreaTop = padTop;
  const volumeAreaTop = padTop + candleAreaH + gapH;

  // 배경
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, width, height);

  // 가격 범위
  const closes = sorted.map((c) => c.close);
  const allPrices = sorted.flatMap((c) => [c.high, c.low]);
  const priceMin = Math.min(...allPrices);
  const priceMax = Math.max(...allPrices);
  const priceRange = priceMax - priceMin || 1;
  const priceMargin = priceRange * 0.05;

  const scaleY = (price: number) =>
    candleAreaTop + candleAreaH - ((price - priceMin + priceMargin) / (priceRange + priceMargin * 2)) * candleAreaH;

  // 거래량 범위
  const maxVolume = Math.max(...sorted.map((c) => c.volume)) || 1;
  const scaleVolY = (vol: number) => volumeAreaTop + volumeAreaH - (vol / maxVolume) * volumeAreaH;

  // 그리드 (가격)
  ctx.strokeStyle = COLOR.gridLine;
  ctx.lineWidth = 0.5;
  const gridLines = 5;
  ctx.font = '11px monospace';
  ctx.fillStyle = COLOR.textLight;
  for (let i = 0; i <= gridLines; i++) {
    const price = priceMin - priceMargin + ((priceRange + priceMargin * 2) * i) / gridLines;
    const y = scaleY(price);
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(width - padRight, y);
    ctx.stroke();
    ctx.fillText(Math.round(price).toLocaleString(), 2, y + 4);
  }

  // 캔들스틱 + 거래량
  const candleW = Math.max(2, (chartW / sorted.length) * 0.7);
  const candleGap = chartW / sorted.length;

  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const x = padLeft + i * candleGap + candleGap / 2;
    const isBull = c.close >= c.open;
    const bodyTop = scaleY(Math.max(c.open, c.close));
    const bodyBottom = scaleY(Math.min(c.open, c.close));
    const bodyH = Math.max(1, bodyBottom - bodyTop);

    // 심지
    ctx.strokeStyle = COLOR.wick;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, scaleY(c.high));
    ctx.lineTo(x, scaleY(c.low));
    ctx.stroke();

    // 캔들 바디
    ctx.fillStyle = isBull ? COLOR.bullCandle : COLOR.bearCandle;
    ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyH);

    // 거래량 바
    ctx.fillStyle = isBull ? COLOR.bullVolume : COLOR.bearVolume;
    const volY = scaleVolY(c.volume);
    ctx.fillRect(x - candleW / 2, volY, candleW, volumeAreaTop + volumeAreaH - volY);
  }

  // MA 라인 그리기
  const drawMA = (period: number, color: string) => {
    const maValues = sma(closes, period);
    if (maValues.length === 0) return;
    const offset = closes.length - maValues.length;

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < maValues.length; i++) {
      const dataIdx = i + offset;
      if (dataIdx < 0 || dataIdx >= sorted.length) continue;
      const x = padLeft + dataIdx * candleGap + candleGap / 2;
      const y = scaleY(maValues[i]);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  };

  drawMA(5, COLOR.ma5);
  drawMA(20, COLOR.ma20);

  // 범례
  ctx.font = '12px monospace';
  const legendY = padTop - 10;
  if (stockCode) {
    ctx.fillStyle = COLOR.textLight;
    ctx.fillText(stockCode, padLeft, legendY);
  }
  ctx.fillStyle = COLOR.ma5;
  ctx.fillText('MA5', padLeft + 80, legendY);
  ctx.fillStyle = COLOR.ma20;
  ctx.fillText('MA20', padLeft + 120, legendY);

  // 날짜 라벨 (하단)
  ctx.fillStyle = COLOR.textLight;
  ctx.font = '10px monospace';
  const labelInterval = Math.max(1, Math.floor(sorted.length / 6));
  for (let i = 0; i < sorted.length; i += labelInterval) {
    const c = sorted[i];
    const x = padLeft + i * candleGap + candleGap / 2;
    const label = `${c.date.slice(4, 6)}/${c.date.slice(6, 8)}`;
    ctx.fillText(label, x - 15, height - 5);
  }

  return Buffer.from(canvas.toBuffer('image/png'));
}
