/**
 * GPS による軌跡記録。
 *
 * 電池と精度のバランスのため、
 *  - 精度が悪い測位（誤差40m超）は捨てる
 *  - 前回記録点から一定距離（8m以上・誤差の半分以上）動いたときだけ記録する
 *  - 歩行ではありえない速度の飛び（GPSの跳ね）は捨てる
 * 標高はGPS高度ではなく国土地理院の標高タイルから求める（GPS高度は誤差が大きいため）。
 *
 * 注意: Web(PWA)では画面を消す・他のアプリに切り替えると測位が止まる。
 * そのため記録中は Screen Wake Lock で画面を点けたままにできるようにしている。
 * 画面オフでの記録はネイティブアプリ化（Capacitor等）が必要。
 */
import { GainCounter, distance } from '../geo';
import type { DemSampler } from '../map/gsiDem';
import { appendPoint, getPoints, putTrack, type Track, type TrackPoint } from './db';

const MAX_ACCURACY_M = 40;
const MIN_STEP_M = 8;
const MAX_SPEED_MPS = 12;

export interface RecorderState {
  track: Track | null;
  points: TrackPoint[];
  lastFix: GeolocationPosition | null;
  error: string | null;
  wakeLock: boolean;
}

export class TrackRecorder {
  private track: Track | null = null;
  private points: TrackPoint[] = [];
  private gain = new GainCounter();
  private watchId: number | null = null;
  private lastFix: GeolocationPosition | null = null;
  private error: string | null = null;
  private rejectedJumps = 0;
  private queue: Promise<void> = Promise.resolve();
  private wakeLock: WakeLockSentinel | null = null;
  keepScreenOn = true;

  constructor(
    private readonly dem: DemSampler,
    private readonly onChange: (s: RecorderState) => void,
  ) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !this.recording) return;
      // バックグラウンドから戻ったら測位とWake Lockを取り直す（iOSで止まることがあるため）
      this.startWatch();
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
      wakeLock: this.wakeLock != null,
    };
  }

  async start(): Promise<void> {
    if (this.recording) return;
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
    this.gain = new GainCounter();
    this.error = null;
    await putTrack(this.track);
    this.startWatch();
    await this.acquireWakeLock();
    this.emit();
  }

  /** 前回途中で閉じられた記録を再開する */
  async resume(track: Track): Promise<void> {
    this.track = track;
    this.points = await getPoints(track.id);
    this.gain = new GainCounter();
    for (const p of this.points) this.gain.push(p.ele);
    this.startWatch();
    await this.acquireWakeLock();
    this.emit();
  }

  async stop(): Promise<Track | null> {
    if (!this.track) return null;
    this.stopWatch();
    await this.queue;
    this.track = { ...this.track, status: 'done', endedAt: Date.now() };
    await putTrack(this.track);
    await this.releaseWakeLock();
    const finished = this.track;
    this.emit();
    return finished;
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

  private startWatch(): void {
    this.stopWatch();
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        this.lastFix = pos;
        this.error = null;
        this.queue = this.queue.then(() => this.handle(pos)).catch((e) => console.error(e));
      },
      (err) => {
        // TIMEOUT は立ち止まっているだけでも起きうるので無視（timeout 未指定なら通常は発生しない）。
        // 一時的な取得失敗も、直近20秒以内に測位できていれば表示しない
        if (err.code === err.TIMEOUT) return;
        const recent = this.lastFix && Date.now() - this.lastFix.timestamp < 20_000;
        if (err.code !== err.PERMISSION_DENIED && recent) return;
        this.error =
          err.code === err.PERMISSION_DENIED
            ? '位置情報の利用が許可されていません'
            : '現在地を取得できません（GPSの電波が弱い可能性があります）';
        this.emit();
      },
      { enableHighAccuracy: true, maximumAge: 0 },
    );
  }

  private stopWatch(): void {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  private async handle(pos: GeolocationPosition): Promise<void> {
    const track = this.track;
    if (!track || track.status !== 'recording') return;
    const { longitude: lng, latitude: lat, accuracy, altitude } = pos.coords;
    if (accuracy > MAX_ACCURACY_M) {
      this.emit();
      return;
    }
    const last = this.points[this.points.length - 1];
    let step = 0;
    if (last) {
      step = distance([last.lng, last.lat], [lng, lat]);
      if (step < Math.max(MIN_STEP_M, accuracy / 2)) {
        this.emit();
        return;
      }
      const dt = (pos.timestamp - last.t) / 1000;
      if (dt > 0 && step / dt > MAX_SPEED_MPS && this.rejectedJumps < 3) {
        this.rejectedJumps++;
        return;
      }
    }
    this.rejectedJumps = 0;
    const ele = await this.dem.elevation(lng, lat);
    const point: TrackPoint = {
      trackId: track.id,
      t: pos.timestamp,
      lng,
      lat,
      alt: altitude,
      acc: accuracy,
      ele,
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
    await appendPoint(this.track, point);
    this.emit();
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
