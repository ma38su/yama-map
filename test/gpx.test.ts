// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { parseGpx, toGpx } from '../src/track/gpx';

const sample = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>槍ヶ岳 &amp; 穂高</name></metadata>
  <wpt lat="36.3420" lon="137.6479"><ele>3180</ele><name>槍ヶ岳</name></wpt>
  <trk><name>day1</name><trkseg>
    <trkpt lat="36.2500" lon="137.6380"><ele>1505</ele><time>2026-08-01T05:00:00Z</time></trkpt>
    <trkpt lat="36.2600" lon="137.6400"><ele>1520.5</ele></trkpt>
  </trkseg></trk>
  <rte><name>plan</name>
    <rtept lat="36.30" lon="137.64"/>
    <rtept lat="36.31" lon="137.65"/>
  </rte>
</gpx>`;

describe('parseGpx', () => {
  it('トラック・ルート・地点を読む', () => {
    const g = parseGpx(sample);
    expect(g.name).toBe('槍ヶ岳 & 穂高');
    expect(g.lines).toHaveLength(2);
    expect(g.lines[0].points[0]).toEqual({
      lng: 137.638,
      lat: 36.25,
      ele: 1505,
      time: Date.parse('2026-08-01T05:00:00Z'),
    });
    expect(g.lines[0].points[1].ele).toBe(1520.5);
    expect(g.lines[1].points[1].ele).toBeUndefined();
    expect(g.waypoints[0].name).toBe('槍ヶ岳');
  });

  it('壊れたファイルはエラー', () => {
    expect(() => parseGpx('<gpx><trk>')).toThrow();
    expect(() => parseGpx('<gpx version="1.1"></gpx>')).toThrow(/含まれていません/);
  });
});

describe('toGpx', () => {
  it('書き出して読み戻せる', () => {
    const pts = [
      { lng: 137.1234567, lat: 36.7654321, ele: 2000.04, time: Date.parse('2026-08-01T06:00:00Z') },
      { lng: 137.124, lat: 36.766 },
    ];
    const g = parseGpx(toGpx('テスト <1>', pts));
    expect(g.name).toBe('テスト <1>');
    expect(g.lines[0].points[0].lng).toBeCloseTo(137.1234567, 6);
    expect(g.lines[0].points[0].ele).toBeCloseTo(2000.0, 1);
    expect(g.lines[0].points[0].time).toBe(pts[0].time);
    expect(g.lines[0].points[1].ele).toBeUndefined();
  });
});
