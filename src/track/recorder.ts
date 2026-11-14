/**
 * GPS による軌跡記録。
 *
 * 電池と精度のバランスのため、
 *  - 精度が悪い測位（誤差40m超）は捨てる
 *  - 前回記録点から一定距離（8m以上・誤差の半分以上）動いたときだけ記録する
 *  - 歩行ではありえない速度の飛び（GPSの跳ね）は捨てる
 * 標高はGPS高度ではなく国土地理院の標高タイルから求める（GPS高度は誤差が大きいため）。
 * 気圧計がある端末（アプリ版）では、気圧の変化で標高を補う（./baroAltitude.ts）。
 *
 * 注意: Web(PWA)では画面を消す・他のアプリに切り替えると測位が止まる。
 * そのため記録中は Screen Wake Lock で画面を点けたままにできるようにしている。
 * Androidアプリ版ではネイティブのバックグラウンド測位を使うので、画面を消しても記録が続く（./location.ts）。
 */
import { GainCounter, distance } from '../geo';
import type { DemSampler } from '../map/gsiDem';
import { BaroFusion } from './baroAltitude';
import { readPressure, setBarometer } from './barometer';
import { appendPoints, getPoints, putTrack, updateElevations, type Track, type TrackPoint } from './db';
import {
  backgroundCapable,
  clearRecordedFixes,
  readRecordedFixes,
  requestTrackingPermissions,
  watchLocation,
  type Fix,
  type LocationWatch,
} from './location';

const MAX_ACCURACY_M = 40;
const MIN_STEP_M = 8;
const MAX_SPEED_MPS = 12;

export interface RecorderState {
  track: Track | null;
  points: TrackPoint[];
  lastFix: Fix | null;
  error: string | null;
  /** 端末に保存できていない点がある（保存できたら false に戻る） */
  saveFailed: boolean;
  wakeLock: boolean;
}

export class TrackRecorder {
  private track: Track | null = null;
  private points: TrackPoint[] = [];
  private gain = new GainCounter();
  private baro = new BaroFusion();
  private watch: LocationWatch | null = null;
  private lastFix: Fix | null = null;
  private error: string | null = null;
  private rejectedJumps = 0;
  /** 端末への保存に失敗した点。次の点と一緒に保存し直す */
  private unsaved: TrackPoint[] = [];
  private queue: Promise<void> = Promise.resolve();
  private wakeLock: WakeLockSentinel | null = null;
  keepScreenOn = true;

  constructor(
    private readonly dem: DemSampler,
    private readonly onChange: (s: RecorderState) => void,
  ) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !this.recording) return;
      // Web版はバックグラウンドから戻ったら測位を取り直す（iOSで止まることがあるため）。
      // アプリ版の測位はバックグラウンドでも続いているので、そのままにする
      if (!backgroundCapable) this.startWatch();
      void this.acquireWakeLock();
    });
  }

  get recording(): boolean {
    return this.track?.status === 'recording';
  }

  get state(): RecorderState {
    return {
      track: this.track,
      points: this.points,
      lastFix: this.lastFix,
      error: this.error,
      saveFailed: this.unsaved.length > 0,
      wakeLock: this.wakeLock != null,
    };
  }

  /** 記録を始める。位置情報が許可されていなければ始めずに false */
  async start(): Promise<boolean> {
    if (this.recording) return true;
    // 許可を先に求める（拒否されたときに、点のない「記録中」の記録を残さないように）
    if (!(await requestTrackingPermissions())) return false;
    const now = Date.now();
    const d = new Date(now);
    const label = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    this.track = {
      id: crypto.randomUUID(),
      name: `${label} の記録`,
      startedAt: now,
      status: 'recording',
      distance: 0,
      ascent: 0,
      descent: 0,
      pointCount: 0,
    };
    this.points = [];
    this.unsaved = [];
    this.gain = new GainCounter();
    this.baro = new BaroFusion();
    this.error = null;
    void setBarometer(true);
    // 記録がブラウザに消されないよう、保存領域の永続化を求める（拒否されても続ける）
    void navigator.storage?.persist?.().catch(() => false);
    await putTrack(this.track);
    this.startWatch();
    await this.acquireWakeLock();
    this.emit();
    return true;
  }

  /** 前回途中で閉じられた記録を再開する（アプリ版で裏で記録が続いていれば、そのまま続ける） */
  async resume(track: Track): Promise<void> {
    await this.load(track);
    void setBarometer(true);
    await requestTrackingPermissions();
    this.startWatch();
    await this.acquireWakeLock();
    this.emit();
  }

  /** 記録を終える。アプリ版は端末にたまっている測位を取り込み終えてから締める。endedAt は終えた時刻（通知の「停止」のとき） */
  async stop(endedAt = Date.now()): Promise<Track | null> {
    if (!this.track) return null;
    await this.stopWatch();
    void setBarometer(false);
    await this.queue;
    return this.close(endedAt);
  }

  /**
   * 途中で閉じられた記録を、再開せずに締める（アプリ版では、端末に残っている測位を取り込んでから）。
   * endedAt がなければ最後の点の時刻
   */
  async finish(track: Track, endedAt?: number): Promise<Track> {
    await this.load(track);
    this.emit();
    await readRecordedFixes(track.id, this.points.at(-1)?.t ?? 0, (fix) => this.enqueue(fix));
    await this.queue;
    return (await this.close(endedAt ?? this.points.at(-1)?.t ?? track.startedAt))!;
  }

  private async close(endedAt: number): Promise<Track | null> {
    if (!this.track) return null;
    this.track = { ...this.track, status: 'done', endedAt };
    await this.save();
    // IndexedDB に保存し終えたら、アプリ版の端末側の測位は消す（保存できていなければ残しておく）
    if (!this.unsaved.length) await clearRecordedFixes(this.track.id);
    await this.releaseWakeLock();
    const finished = this.track;
    this.emit();
    return finished;
  }

  /** 保存してある記録と点を読み込み、続きを記録できるようにする */
  private async load(track: Track): Promise<void> {
    this.track = { ...track, status: 'recording' };
    this.points = await getPoints(track.id);
    this.unsaved = [];
    this.rejectedJumps = 0;
    this.error = null;
    this.gain = new GainCounter();
    this.baro = new BaroFusion();
    for (const p of this.points) {
      this.gain.push(p.ele);
      if (p.hpa != null) this.baro.push(p.t, p.hpa, p.dem ?? p.ele);
    }
  }

  /** 記録中の今の標高を気圧計から求める（気圧計がない・まだ合わせられていなければ null） */
  async currentAltitude(): Promise<number | null> {
    if (!this.recording) return null;
    const hpa = await readPressure();
    return hpa != null ? this.baro.altitude(hpa) : null;
  }

  /** 記録終了後の表示をクリア */
  clear(): void {
    if (this.recording) return;
    this.track = null;
    this.points = [];
    this.emit();
  }

  async setKeepScreenOn(on: boolean): Promise<void> {
    this.keepScreenOn = on;
    if (on && this.recording) await this.acquireWakeLock();
    if (!on) await this.releaseWakeLock();
    this.emit();
  }

  private enqueue(fix: Fix): void {
    this.lastFix = fix;
    this.error = null;
    this.queue = this.queue.then(() => this.handle(fix)).catch((e) => console.error(e));
  }

  private startWatch(): void {
    const track = this.track;
    if (!track) return;
    void this.stopWatch();
    this.watch = watchLocation(
      (fix) => this.enqueue(fix),
      (err) => {
        // 一時的な取得失敗は、直近20秒以内に測位できていれば表示しない
        const recent = this.lastFix && Date.now() - this.lastFix.timestamp < 20_000;
        if (err !== 'denied' && recent) return;
        this.error =
          err === 'denied' ? '位置情報の利用が許可されていません' : '現在地を取得できません（GPSの電波が弱い可能性があります）';
        this.emit();
      },
      {
        trackId: track.id,
        startedAt: track.startedAt,
        since: this.points.at(-1)?.t ?? 0,
        // 通知の「停止」で止められたら、ここまでで締める
        onEnded: (endedAt) => void this.stop(endedAt),
      },
    );
  }

  private async stopWatch(): Promise<void> {
    const watch = this.watch;
    this.watch = null;
    await watch?.stop();
  }

  private async handle(pos: Fix): Promise<void> {
    const track = this.track;
    if (!track || track.status !== 'recording') return;
    const { lng, lat, accuracy, altitude } = pos;
    if (accuracy > MAX_ACCURACY_M) return this.settle(pos);
    const last = this.points[this.points.length - 1];
    let step = 0;
    if (last) {
      step = distance([last.lng, last.lat], [lng, lat]);
      if (step < Math.max(MIN_STEP_M, accuracy / 2)) return this.settle(pos);
      const dt = (pos.timestamp - last.t) / 1000;
      if (dt > 0 && step / dt > MAX_SPEED_MPS && this.rejectedJumps < 3) {
        this.rejectedJumps++;
        return this.settle(pos);
      }
    }
    this.rejectedJumps = 0;
    // アプリ版は測位と一緒に残した気圧を使う（取り込むのが後になっても、その時の気圧）
    const [dem, hpa] = await Promise.all([this.dem.elevation(lng, lat), pos.hpa !== undefined ? pos.hpa : readPressure()]);
    const ele = hpa != null ? this.baro.push(pos.timestamp, hpa, dem) : dem;
    const point: TrackPoint = {
      trackId: track.id,
      t: pos.timestamp,
      lng,
      lat,
      alt: altitude,
      acc: accuracy,
      ele,
      ...(hpa != null ? { hpa, dem } : {}),
    };
    this.points.push(point);
    this.gain.push(ele);
    this.track = {
      ...track,
      distance: track.distance + step,
      ascent: this.gain.ascent,
      descent: this.gain.descent,
      pointCount: this.points.length,
    };
    this.unsaved.push(point);
    await this.settle(pos);
  }

  /** まとめて取り込んでいるあいだは何もせず、最後の1点（ふだんの測位は毎回）で、たまった点を保存して知らせる */
  private async settle(pos: Fix): Promise<void> {
    if (pos.more) return;
    if (this.unsaved.length) await this.save();
    this.emit();
  }

  /** 記録の概要と、まだ保存できていない点を保存する。失敗したら点は覚えておき、次にやり直す */
  private async save(): Promise<void> {
    if (!this.track) return;
    const points = this.unsaved;
    try {
      if (points.length) await appendPoints(this.track, points);
      else await putTrack(this.track);
      this.unsaved = this.unsaved.slice(points.length);
    } catch (e) {
      console.error('記録を保存できませんでした', e);
    }
  }

  private async acquireWakeLock(): Promise<void> {
    if (!this.keepScreenOn || !('wakeLock' in navigator) || this.wakeLock) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => {
        this.wakeLock = null;
        this.emit();
      });
    } catch {
      this.wakeLock = null;
    }
  }

  private async releaseWakeLock(): Promise<void> {
    const lock = this.wakeLock;
    this.wakeLock = null;
    await lock?.release().catch(() => undefined);
  }

  private emit(): void {
    this.onChange(this.state);
  }
}

/**
 * 標高が取れていない点（圏外で標高タイルを読めなかったときなど）を標高タイルから埋めて保存し、登り・下りを数え直す。
 * points の標高はその場で書き換える。埋められた点がなければ null
 */
export async function fillMissingElevations(
  track: Track,
  points: TrackPoint[],
  elevation: (lng: number, lat: number) => Promise<number | null>,
): Promise<Track | null> {
  const eles = new Map<number, number>();
  for (const p of points) {
    if (p.ele != null) continue;
    const ele = await elevation(p.lng, p.lat);
    if (ele != null) eles.set(p.t, ele);
  }
  if (!eles.size) return null;
  const gain = new GainCounter();
  for (const p of points) {
    p.ele ??= eles.get(p.t) ?? null;
    gain.push(p.ele);
  }
  const updated = { ...track, ascent: gain.ascent, descent: gain.descent };
  await updateElevations(track.id, eles);
  await putTrack(updated);
  return updated;
}
