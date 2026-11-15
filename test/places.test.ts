import { describe, expect, it } from 'vitest';
import {
  PLACE_CATS,
  cellsBounds,
  commonsSearchUrl,
  fromGeoJson,
  fromWaypoints,
  fromTilePois,
  inatUrl,
  osmDetails,
  osmKind,
  overpassQuery,
  parseCommonsInfo,
  parseCommonsSearch,
  parseInat,
  parseOverpass,
  placeCellBounds,
  placeCellKey,
  placeCellsIn,
  splitByCell,
  stripHtml,
  tilePoiKind,
} from '../src/places/sources';

describe('マス目', () => {
  it('点のマス目と、その範囲', () => {
    const key = placeCellKey([139.4165, 36.8705]);
    expect(key).toBe('2788,737');
    expect(placeCellBounds(key)).toEqual([139.4, 36.85, 139.45, 36.9]);
  });
  it('範囲にかかるマス目は、中心に近い順・上限まで', () => {
    const cells = placeCellsIn([139.36, 36.82, 139.49, 36.93]);
    expect(cells.length).toBe(9);
    expect(cells[0]).toBe('2788,737');
    expect(placeCellsIn([139.36, 36.82, 139.49, 36.93], 4)).toHaveLength(4);
  });
  it('マス目をまとめた範囲', () => {
    expect(cellsBounds(['2788,737', '2789,738'])).toEqual([139.4, 36.85, 139.5, 36.95]);
  });
  it('範囲で取った場所をマス目に分ける（空のマス目も入れる）', () => {
    const items = parseOverpass({ elements: [{ type: 'node', id: 1, lat: 36.87, lon: 139.41, tags: { amenity: 'toilets' } }] });
    const m = splitByCell(items, ['2788,737', '2789,737']);
    expect(m.get('2788,737')).toHaveLength(1);
    expect(m.get('2789,737')).toEqual([]);
  });
});

describe('Wikimedia Commons', () => {
  it('探す URL は北・西・南・東の順', () => {
    expect(decodeURIComponent(commonsSearchUrl('2788,737'))).toContain('gsbbox=36.9|139.4|36.85|139.45');
  });
  it('位置が大ざっぱな写真は除く', () => {
    const geo = parseCommonsSearch({
      query: {
        geosearch: [
          { pageid: 1, title: 'File:A.jpg', lat: 36.9, lon: 139.4 },
          { pageid: 2, title: 'File:B - panoramio.jpg', lat: 36.85339, lon: 139.411697 },
        ],
      },
    });
    expect(geo.map((g) => g.pageid)).toEqual([2]);
  });
  it('画像・撮った人・ライセンスを読む（計測用の ?utm を外し、大きな画像は 960px）', () => {
    const geo = [{ pageid: 2, title: 'File:The_Trail - panoramio.jpg', lat: 36.85, lon: 139.41 }];
    const [it] = parseCommonsInfo(geo, {
      query: {
        pages: {
          2: {
            pageid: 2,
            title: 'File:The_Trail - panoramio.jpg',
            imageinfo: [
              {
                thumburl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/0/09/T.jpg/330px-T.jpg?utm_source=commons',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:T.jpg',
                extmetadata: { Artist: { value: '<a href="x">jtease</a>' }, LicenseShortName: { value: 'CC BY 3.0' }, DateTimeOriginal: { value: '2010-07-06' } },
              },
            ],
          },
        },
      },
    });
    expect(it).toMatchObject({
      id: 'commons:2',
      cat: 'photo',
      lngLat: [139.41, 36.85],
      title: 'The Trail',
      thumb: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/0/09/T.jpg/330px-T.jpg',
      image: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/0/09/T.jpg/960px-T.jpg',
      credit: 'jtease',
      license: 'CC BY 3.0',
    });
    expect(it.time).toBe(Date.parse('2010-07-06'));
  });
  it('HTML を1行の文字にする', () => {
    expect(stripHtml('<span>a &amp; b</span>\n <i>c</i>')).toBe('a & b c');
  });
});

describe('iNaturalist', () => {
  it('URL に範囲と、使えるライセンスだけ', () => {
    const u = new URL(inatUrl('2788,737'));
    expect(u.searchParams.get('swlat')).toBe('36.85');
    expect(u.searchParams.get('nelng')).toBe('139.45');
    expect(u.searchParams.get('photo_license')).not.toContain('all rights');
    expect(u.searchParams.get('quality_grade')).toBe('research');
  });
  it('和名・学名・写真を読み、位置をぼかした記録は除く', () => {
    const items = parseInat({
      results: [
        {
          id: 10,
          location: '36.8779,139.4131',
          observed_on: '2026-03-11',
          uri: 'https://www.inaturalist.org/observations/10',
          taxon: { name: 'Fomitopsis pinicola', preferred_common_name: 'ツガサルノコシカケ' },
          photos: [{ url: 'https://inaturalist-open-data.s3.amazonaws.com/photos/1/square.jpg', attribution: '(c) a', license_code: 'cc-by-nc' }],
        },
        { id: 11, location: '36.87,139.41', obscured: true, photos: [{ url: 'x/square.jpg', license_code: 'cc-by' }] },
        { id: 12, location: '36.87,139.41', photos: [{ url: 'x/square.jpg', license_code: null }] },
        {
          id: 13,
          location: '36.87,139.41',
          taxon: { name: 'Polygonia c-aureum' },
          photos: [{ url: 'x/square.jpg', attribution: '(c) b, some rights reserved (CC BY)', license_code: 'cc-by' }],
        },
      ],
    });
    expect(items).toHaveLength(2);
    // 撮った人の表示にライセンスが入っていれば、重ねて出さない
    expect(items[1]).toMatchObject({ id: 'inat:13', title: 'Polygonia c-aureum', subtitle: undefined, license: undefined });
    expect(items[0]).toMatchObject({
      id: 'inat:10',
      cat: 'life',
      lngLat: [139.4131, 36.8779],
      title: 'ツガサルノコシカケ',
      subtitle: 'Fomitopsis pinicola',
      thumb: 'https://inaturalist-open-data.s3.amazonaws.com/photos/1/small.jpg',
      image: 'https://inaturalist-open-data.s3.amazonaws.com/photos/1/medium.jpg',
      license: 'CC-BY-NC',
    });
  });
});

describe('OpenStreetMap', () => {
  it('問い合わせは南・西・北・東の順', () => {
    expect(overpassQuery([139.4, 36.85, 139.45, 36.9])).toContain('(36.85,139.4,36.9,139.45)');
  });
  it('タグから種類を決める', () => {
    expect(osmKind({ tourism: 'alpine_hut' })).toBe('hut');
    expect(osmKind({ amenity: 'shelter' })).toBe('shelter');
    expect(osmKind({ natural: 'spring' })).toBe('spring');
    expect(osmKind({ natural: 'hot_spring' })).toBe('onsen');
    expect(osmKind({ waterway: 'waterfall' })).toBe('fall');
    expect(osmKind({ highway: 'path' })).toBeNull();
    // 宿・見どころ・山頂（名前のあるものだけ）・バス停・駐車場
    expect(osmKind({ tourism: 'hotel', name: '日光沢温泉' })).toBe('inn');
    expect(osmKind({ tourism: 'guest_house' })).toBe('inn');
    expect(osmKind({ tourism: 'attraction' })).toBe('attraction');
    expect(osmKind({ natural: 'peak', name: '黒岩山' })).toBe('peak');
    expect(osmKind({ natural: 'peak' })).toBeNull();
    expect(osmKind({ highway: 'bus_stop' })).toBe('bus');
    expect(osmKind({ amenity: 'parking' })).toBe('parking');
  });
  it('役立つタグを日本語にする', () => {
    expect(osmDetails({ ele: '1850.4', drinking_water: 'yes', fee: 'no', capacity: '40', ele_bad: 'x' })).toEqual([
      '標高 1,850 m',
      '収容 40人',
      '料金 なし',
      '飲用 可',
    ]);
    expect(osmDetails({ ele: 'unknown' })).toEqual([]);
  });
  it('点・面（中心）を場所にし、名前がなければ種類の名前', () => {
    const items = parseOverpass({
      elements: [
        { type: 'node', id: 1, lat: 36.87, lon: 139.41, tags: { tourism: 'alpine_hut', name: '手白澤温泉', 'name:ja': '手白澤ヒュッテ' } },
        { type: 'way', id: 2, center: { lat: 36.86, lon: 139.42 }, tags: { natural: 'spring' } },
        { type: 'node', id: 3, lat: 36.86, lon: 139.42, tags: { highway: 'path' } },
      ],
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: 'osm:node/1', cat: 'hut', title: '手白澤ヒュッテ', subtitle: '山小屋', url: 'https://www.openstreetmap.org/node/1' });
    expect(items[1]).toMatchObject({ id: 'osm:way/2', cat: 'water', title: '湧き水', lngLat: [139.42, 36.86] });
  });
  it('OpenFreeMap の地図データの点（Overpass が混んでいるときの代わり）', () => {
    expect(tilePoiKind('lodging', 'alpine_hut')).toBe('hut');
    expect(tilePoiKind('shelter', 'shelter')).toBe('shelter');
    expect(tilePoiKind('toilets', 'toilets')).toBe('toilet');
    expect(tilePoiKind('lodging', 'hotel')).toBe('inn');
    expect(tilePoiKind('bus', 'bus_stop')).toBe('bus');
    expect(tilePoiKind('shop', 'convenience')).toBeNull();
    const items = fromTilePois([
      { cls: 'shelter', subclass: 'shelter', name: '間欠泉展望台', lngLat: [139.4123456789, 36.87] },
      { cls: 'bus', subclass: 'bus_stop', name: '女夫渕', lngLat: [139.4, 36.86] },
      { cls: 'shop', subclass: 'convenience', name: 'コンビニ', lngLat: [139.4, 36.86] },
    ]);
    expect(items).toEqual([
      {
        id: 'osm:tile/shelter/139.412346,36.87',
        source: 'osm',
        cat: 'hut',
        lngLat: [139.412346, 36.87],
        title: '間欠泉展望台',
        subtitle: '避難小屋・あずまや',
        url: 'https://www.openstreetmap.org/?mlat=36.87&mlon=139.412346#map=18/36.87/139.412346',
      },
      {
        id: 'osm:tile/bus/139.4,36.86',
        source: 'osm',
        cat: 'bus',
        lngLat: [139.4, 36.86],
        title: '女夫渕',
        subtitle: 'バス停',
        url: 'https://www.openstreetmap.org/?mlat=36.86&mlon=139.4#map=18/36.86/139.4',
      },
    ]);
  });
  it('答えが読めなければ例外（混んでいるときのエラー）', () => {
    expect(() => parseOverpass({ remark: 'runtime error' })).toThrow();
  });
});

describe('自分で読み込む場所', () => {
  it('GeoJSON の点を読む（名前・コメント・写真・種類）', () => {
    const items = fromGeoJson(
      {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: 'a',
            geometry: { type: 'Point', coordinates: [139.41, 36.87] },
            properties: { name: '分岐', comment: '右へ\n道標あり', photo: 'https://example.com/p.jpg', time: '2026-10-01T09:00:00+09:00', author: 'me' },
          },
          { type: 'Feature', geometry: { type: 'Point', coordinates: [139.42, 36.86] }, properties: { title: '水場', category: 'water' } },
          { type: 'Feature', geometry: { type: 'Point', coordinates: [139.43, 36.86] }, properties: { category: 'photo' } },
          { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} },
        ],
      },
      'imp',
    );
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      id: 'user:imp/a',
      source: 'user',
      cat: 'mine',
      title: '分岐',
      details: ['右へ', '道標あり'],
      thumb: 'https://example.com/p.jpg',
      image: 'https://example.com/p.jpg',
      credit: 'me',
      time: Date.parse('2026-10-01T09:00:00+09:00'),
    });
    expect(items[1]).toMatchObject({ cat: 'water', title: '水場' });
    // 公開データの種類（写真など）は指定できない
    expect(items[2]).toMatchObject({ cat: 'mine', title: 'コメント' });
  });
  it('GeoJSON でなければ例外', () => {
    expect(() => fromGeoJson({ foo: 1 }, 'x')).toThrow();
  });
  it('GPX のウェイポイントを読む', () => {
    expect(fromWaypoints([{ lng: 139.4, lat: 36.8, name: '登山口', desc: '駐車場', link: 'https://example.com' }], 'g')).toEqual([
      { id: 'user:g/0', source: 'user', cat: 'mine', lngLat: [139.4, 36.8], title: '登山口', url: 'https://example.com', time: undefined, details: ['駐車場'] },
    ]);
  });
  it('種類ごとに違う色', () => {
    const colors = Object.values(PLACE_CATS).map((c) => c.color);
    expect(new Set(colors).size).toBe(colors.length);
  });
});
