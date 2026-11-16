/**
 * 画面のあちこちから読み書きする状態。モジュールをまたいで変わる値はここに置く
 * （ES モジュールの let は読み込んだ側から書き換えられないため）。
 */
import type { LngLat } from '../geo';
import { RouteTimeline } from '../nav/eta';
import { loadSavedRoute, type ActiveRoute, type PlanPoint } from '../nav/plan';
import type { Track, TrackPoint } from '../track/db';
import type { Nav } from './nav';

const savedRoute = loadSavedRoute();

export const state = {
  /** 表示中のルート */
  route: savedRoute as ActiveRoute | null,
  /** ルートに沿った標準時間の累積（到着予想用） */
  timeline: (savedRoute ? new RouteTimeline(savedRoute.dists, savedRoute.eles) : null) as RouteTimeline | null,
  /** ルートができる前に選ばれた地点（出発地待ちなど） */
  pending: [] as PlanPoint[],
  /** ルートを計算中か */
  building: false,
  /**
   * 地図に表示している記録（記録中ならその記録）。points は記録の範囲（track.trim）の中の点、all は全部の点。
   * route は記録と一緒に保存したルート（null はルートなし。読み込むまでと計画のリプレイは undefined で、そのあいだは表示中のルートを使う）
   */
  shown: null as { track: Track; points: TrackPoint[]; all: TrackPoint[]; route?: ActiveRoute | null } | null,
  /** 最後に計算した到着予想 */
  lastNav: null as Nav | null,
  /** 地図の現在地ボタンで最後に分かった位置 */
  lastFix: null as { coords: LngLat; acc: number; t: number } | null,
  /** 現在地の標高 */
  currentEle: null as number | null,
  /** 空や地図の色をこの時刻 (ms) に合わせる（リプレイ中）。null なら今の時刻 */
  daylightAt: null as number | null,
  /** 読み込み中などの進み具合の表示（あれば状態表示に優先して出す） */
  progressMsg: '',
  /** 記録の点を書き換えた回数（あとから標高を埋めたときなど）。点の数で覚えている計算を作り直す目印 */
  revision: 0,
};
