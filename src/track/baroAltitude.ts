/**
 * 気圧計で標高を補う。
 * 気圧から求めた高さ（気圧高度）は、上り下りの変化は1m ほどの細かさで分かるが、天気で気圧が変わるとずれていく。
 * 標高タイルの標高は平均すると正しいが、GPS の位置が10m ずれるだけで急斜面では何十m も変わる。
 * そこで「気圧高度 + ずれ」を標高とし、ずれ（標高タイル − 気圧高度）をゆっくり追いかける：
 *  - 最初の数点は平均（1点目の標高タイルの値に引きずられないように）
 *  - その後は時定数 TAU_MS の指数平滑。天気による気圧の変化（1時間に1hPa ≒ 8m 程度）には追いつき、
 *    1点ごとの標高タイルの揺れはならす
 *  - 1回に動かすのは MAX_STEP_M まで（橋や崖の上で標高タイルが大きく外れた点に引っぱられないように）
 */

const TAU_MS = 20 * 60_000;
const MAX_STEP_M = 3;

/** 気圧 (hPa) → 標準大気での高さ (m) */
export const pressureAltitude = (hPa: number) => 44330 * (1 - Math.pow(hPa / 1013.25, 1 / 5.255));

export class BaroFusion {
  /** 標高タイル − 気圧高度 (m) */
  offset: number | null = null;
  private n = 0;
  private lastT = 0;

  /** 点を1つ足して、その点の標高を返す。気圧がなければ標高タイルの値のまま */
  push(t: number, hPa: number | null | undefined, dem: number | null | undefined): number | null {
    if (hPa == null || !Number.isFinite(hPa)) return dem ?? null;
    const baro = pressureAltitude(hPa);
    if (dem != null) {
      const target = dem - baro;
      this.n++;
      if (this.offset == null) this.offset = target;
      else {
        const k = Math.max(1 / this.n, 1 - Math.exp(-Math.max(0, t - this.lastT) / TAU_MS));
        let step = (target - this.offset) * k;
        // 最初の平均のあいだは制限しない
        if (this.n > 5) step = Math.max(-MAX_STEP_M, Math.min(MAX_STEP_M, step));
        this.offset += step;
      }
      this.lastT = t;
    }
    return this.offset == null ? (dem ?? null) : baro + this.offset;
  }

  /** 今の気圧からの標高（点を足さずに、現在地の標高を出すとき） */
  altitude(hPa: number): number | null {
    return this.offset == null ? null : pressureAltitude(hPa) + this.offset;
  }
}
