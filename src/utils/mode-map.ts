/**
 * 🔒 ModeMap — paper/live 모드 격리를 강제하는 컨테이너
 *
 * 배경: 모듈 레벨 mutable state (let isRunning = false, Map, Set)이 paper/live 양쪽에서
 *      읽고/쓰면 cross-contamination 발생. 과거 P0/P1 contamination 커밋이 10+ 이유.
 *
 * 해결: 모든 모드-종속 state를 이 컨테이너로 강제. 컴파일 타임에 모드 분리 보장.
 *
 * 사용 예:
 *   const isRunning = new ModeMap<boolean>(false);
 *   isRunning.set(paper, true);   // paper만 true, live는 영향 없음
 *   isRunning.get(live);          // false
 *
 *   // 자동 감지 (현재 컨텍스트 기반)
 *   isRunningCtx.setForCurrentCtx(true);
 *   isRunningCtx.getForCurrentCtx();
 */

import { getCtxIsPaper } from '../config/context.js';

export class ModeMap<T> {
  private readonly _paper: T;
  private readonly _live: T;
  private _paperValue: T;
  private _liveValue: T;

  constructor(initial: T) {
    this._paper = initial;
    this._live = initial;
    this._paperValue = initial;
    this._liveValue = initial;
  }

  /** 명시적 모드로 값 읽기 (선호) */
  get(isPaper: boolean): T {
    return isPaper ? this._paperValue : this._liveValue;
  }

  /** 명시적 모드로 값 쓰기 (선호) */
  set(isPaper: boolean, value: T): void {
    if (isPaper) this._paperValue = value;
    else this._liveValue = value;
  }

  /** 현재 ALS 컨텍스트 기반 읽기 — 컨텍스트가 없으면 baseIsPaper 폴백 */
  getForCurrentCtx(): T {
    return this.get(getCtxIsPaper());
  }

  /** 현재 ALS 컨텍스트 기반 쓰기 */
  setForCurrentCtx(value: T): void {
    this.set(getCtxIsPaper(), value);
  }

  /** 둘 다 리셋 */
  reset(): void {
    this._paperValue = this._paper;
    this._liveValue = this._live;
  }

  /** paper와 live 둘 다 같은 값으로 설정 (조심해서 사용 — 정상 사용 시 거의 불필요) */
  setBoth(value: T): void {
    this._paperValue = value;
    this._liveValue = value;
  }
}

/**
 * Map을 paper/live로 분리된 두 Map으로 관리
 * (e.g. const lastFetched = new ModeMapOf<string, number>())
 */
export class ModeMapOf<K, V> {
  private readonly _paper = new Map<K, V>();
  private readonly _live = new Map<K, V>();

  for(isPaper: boolean): Map<K, V> {
    return isPaper ? this._paper : this._live;
  }

  forCurrentCtx(): Map<K, V> {
    return this.for(getCtxIsPaper());
  }

  /** 둘 다 비우기 */
  clearAll(): void {
    this._paper.clear();
    this._live.clear();
  }

  sizeAll(): { paper: number; live: number } {
    return { paper: this._paper.size, live: this._live.size };
  }
}

/** Set을 paper/live로 분리 */
export class ModeSetOf<V> {
  private readonly _paper = new Set<V>();
  private readonly _live = new Set<V>();

  for(isPaper: boolean): Set<V> {
    return isPaper ? this._paper : this._live;
  }

  forCurrentCtx(): Set<V> {
    return this.for(getCtxIsPaper());
  }

  clearAll(): void {
    this._paper.clear();
    this._live.clear();
  }
}
