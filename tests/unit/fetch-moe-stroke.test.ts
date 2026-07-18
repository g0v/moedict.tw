/**
 * Regression for g0v/moedict-webkit#227「町字筆順錯誤」.
 *
 * `commands/fetch-moe-stroke.mjs` re-derives official MOE stroke-order data
 * from the redesigned (2024-12-27 / 2025-01-02) 教育部《國字標準字體筆順學習
 * 網》(https://stroke-order.learningweb.moe.edu.tw/), whose expanded 6,063
 * -character coverage (2020: 4808→6057, 2024: 6057→6063) now includes 町
 * (U+753A), even though it was never in the original 4,808-character set
 * that g0v/zh-stroke-data (and thus moedict.tw's R2 `stroke-json/` mirror)
 * was built from.
 *
 * The fixture below is a trimmed, byte-faithful excerpt of the real
 * `dictView.jsp?ID=30010` response captured 2026-07-12 (script tags/JS
 * variables preceding and including `xml[30010]="...";` kept verbatim; only
 * unrelated surrounding HTML — nav, footer, other `<script src>` tags — was
 * cut, at a `var voice_exp` / `var bat=[];` boundary that does not touch the
 * XML payload). This locks in the real conversion path against real MOE
 * output rather than a hand-written approximation.
 */

import { describe, expect, it } from "vite-plus/test";
import {
  extractInlineStrokeXml,
  parseMoeStrokeXml,
  toDecimalCodepoint,
  toHexCodepoint,
  fetchAndConvertMoeStroke,
} from "../../commands/fetch-moe-stroke.mjs";

// Byte-faithful excerpt of https://stroke-order.learningweb.moe.edu.tw/dictView.jsp?ID=30010
// (captured 2026-07-12; MOE copyright, CC BY-NC-ND 3.0 TW notice on the
// animation content — see commands/fetch-moe-stroke.mjs header for the
// Copyright Act §50 provenance basis already relied on by g0v/zh-stroke-data
// for this project's existing stroke-json corpus).
const MOE_DICTVIEW_HTML_FIXTURE = `<html><body><script>
var voice_exp, voice_F;
var str_Url = 'https://stroke-order.learningweb.moe.edu.tw/';

var word ='町', uni=30010;
var xml_url = 'https://stroke-order.learningweb.moe.edu.tw/provideStrokeInfo.do?ucs=753A&useAlt=0'
, mp3='/sound/1220.mp3'
, M='/sound/M/M0.WAV'
, F='/sound/F/F0.WAV'
, w='町';

var picSize=Math.min(window.innerHeight, window.innerWidth-32, 512);

var xml=[], id=30010, times=0, n=1
, url="<iframe src='https://stroke-order.learningweb.moe.edu.tw/dictFrame.jsp?ID=30010' frameborder=0 width=300 height=520 allow='fullscreen'></iframe>"
;
xml[30010]="<?xml version=\\"1.0\\" encoding=\\"UTF-8\\"?>\\n<Word version=\\"1.0\\" unicode=\\"町\\">\\n  <Stroke>\\n    <Outline>\\n      <MoveTo x=\\"304.0\\" y=\\"1227.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"298.0\\" y1=\\"1246.0\\" x2=\\"291.0\\" y2=\\"1262.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"284.0\\" y1=\\"1278.0\\" x2=\\"269.5\\" y2=\\"1283.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"255.0\\" y1=\\"1288.0\\" x2=\\"234.0\\" y2=\\"1261.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"218.0\\" y1=\\"1243.0\\" x2=\\"216.5\\" y2=\\"1200.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"215.0\\" y1=\\"1157.0\\" x2=\\"214.0\\" y2=\\"1141.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"178.0\\" y=\\"699.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"173.0\\" y1=\\"641.0\\" x2=\\"164.5\\" y2=\\"616.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"156.0\\" y1=\\"591.0\\" x2=\\"147.5\\" y2=\\"571.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"139.0\\" y1=\\"552.0\\" x2=\\"127.0\\" y2=\\"537.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"115.0\\" y1=\\"522.0\\" x2=\\"112.5\\" y2=\\"509.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"110.0\\" y1=\\"497.0\\" x2=\\"117.0\\" y2=\\"490.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"124.0\\" y1=\\"483.0\\" x2=\\"141.0\\" y2=\\"483.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"167.0\\" y1=\\"484.0\\" x2=\\"197.0\\" y2=\\"494.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"244.0\\" y=\\"510.0\\" />\\n      <QuadTo flexible=\\"true\\" x1=\\"269.5\\" y1=\\"535.0\\" x2=\\"261.0\\" y2=\\"566.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"280.0\\" y=\\"833.0\\" />\\n      <LineTo flexible=\\"true\\" x=\\"282.0\\" y=\\"872.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"302.0\\" y=\\"1152.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"303.0\\" y=\\"1159.0\\" />\\n      <LineTo flexible=\\"true\\" x=\\"304.0\\" y=\\"1227.0\\" />\\n    </Outline>\\n    <Track>\\n      <MoveTo x=\\"180.0\\" y=\\"520.0\\" />\\n      <MoveTo x=\\"225.0\\" y=\\"780.0\\" />\\n      <MoveTo x=\\"250.0\\" y=\\"1110.0\\" />\\n      <MoveTo x=\\"270.0\\" y=\\"1215.0\\" />\\n    </Track>\\n  </Stroke>\\n  <Stroke>\\n    <Outline>\\n      <MoveTo x=\\"244.0\\" y=\\"510.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"497.0\\" y=\\"471.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"533.0\\" y1=\\"466.0\\" x2=\\"596.0\\" y2=\\"452.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"659.0\\" y1=\\"438.0\\" x2=\\"689.5\\" y2=\\"424.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"720.0\\" y1=\\"411.0\\" x2=\\"730.0\\" y2=\\"410.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"747.0\\" y1=\\"409.0\\" x2=\\"778.5\\" y2=\\"422.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"810.0\\" y1=\\"435.0\\" x2=\\"837.5\\" y2=\\"450.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"865.0\\" y1=\\"466.0\\" x2=\\"882.5\\" y2=\\"485.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"900.0\\" y1=\\"504.0\\" x2=\\"898.0\\" y2=\\"518.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"897.0\\" y1=\\"523.0\\" x2=\\"881.5\\" y2=\\"543.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"866.0\\" y1=\\"564.0\\" x2=\\"861.5\\" y2=\\"588.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"857.0\\" y1=\\"613.0\\" x2=\\"848.0\\" y2=\\"668.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"786.0\\" y=\\"1036.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"761.0\\" y=\\"1175.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"753.0\\" y1=\\"1235.0\\" x2=\\"731.0\\" y2=\\"1252.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"709.0\\" y1=\\"1269.0\\" x2=\\"692.0\\" y2=\\"1259.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"675.0\\" y1=\\"1251.0\\" x2=\\"675.0\\" y2=\\"1225.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"673.0\\" y=\\"1197.0\\" />\\n      <LineTo flexible=\\"true\\" x=\\"674.0\\" y=\\"1151.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"681.0\\" y=\\"1092.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"707.0\\" y=\\"827.0\\" />\\n      <LineTo flexible=\\"true\\" x=\\"726.0\\" y=\\"638.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"732.0\\" y1=\\"573.0\\" x2=\\"730.0\\" y2=\\"551.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"728.0\\" y1=\\"529.0\\" x2=\\"717.0\\" y2=\\"520.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"706.0\\" y1=\\"511.0\\" x2=\\"683.0\\" y2=\\"510.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"660.0\\" y1=\\"510.0\\" x2=\\"646.0\\" y2=\\"512.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"517.0\\" y=\\"530.0\\" />\\n      <LineTo flexible=\\"true\\" x=\\"408.0\\" y=\\"545.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"261.0\\" y=\\"566.0\\" />\\n      <QuadTo flexible=\\"true\\" x1=\\"199.5\\" y1=\\"551.0\\" x2=\\"244.0\\" y2=\\"510.0\\" />\\n    </Outline>\\n    <Track>\\n      <MoveTo x=\\"280.0\\" y=\\"536.0\\" />\\n      <MoveTo x=\\"751.0\\" y=\\"416.0\\" size=\\"110.0\\" />\\n      <MoveTo x=\\"856.0\\" y=\\"488.0\\" size=\\"130.0\\" />\\n      <MoveTo x=\\"721.0\\" y=\\"1218.0\\" />\\n    </Track>\\n  </Stroke>\\n  <Stroke>\\n    <Outline>\\n      <MoveTo x=\\"438.0\\" y=\\"878.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"408.0\\" y1=\\"883.0\\" x2=\\"393.0\\" y2=\\"885.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"378.0\\" y1=\\"888.0\\" x2=\\"369.0\\" y2=\\"888.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"340.0\\" y1=\\"891.0\\" x2=\\"329.0\\" y2=\\"886.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"282.0\\" y=\\"872.0\\" />\\n      <QuadTo flexible=\\"true\\" x1=\\"244.0\\" y1=\\"858.5\\" x2=\\"280.0\\" y2=\\"833.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"438.0\\" y=\\"803.0\\" />\\n      <LineTo flexible=\\"true\\" x=\\"541.0\\" y=\\"782.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"564.0\\" y1=\\"777.0\\" x2=\\"585.0\\" y2=\\"772.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"606.0\\" y1=\\"768.0\\" x2=\\"635.0\\" y2=\\"768.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"664.0\\" y1=\\"769.0\\" x2=\\"695.0\\" y2=\\"783.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"710.0\\" y=\\"790.0\\" />\\n      <QuadTo flexible=\\"true\\" x1=\\"741.5\\" y1=\\"811.5\\" x2=\\"707.0\\" y2=\\"827.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"664.0\\" y=\\"838.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"538.0\\" y=\\"860.0\\" />\\n      <LineTo flexible=\\"true\\" x=\\"438.0\\" y=\\"878.0\\" />\\n    </Outline>\\n    <Track>\\n      <MoveTo x=\\"380.0\\" y=\\"855.0\\" />\\n      <MoveTo x=\\"630.0\\" y=\\"795.0\\" />\\n    </Track>\\n  </Stroke>\\n  <Stroke>\\n    <Outline>\\n      <MoveTo x=\\"436.0\\" y=\\"1138.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"438.0\\" y=\\"878.0\\" />\\n      <LineTo flexible=\\"true\\" x=\\"438.0\\" y=\\"803.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"439.0\\" y=\\"693.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"439.0\\" y1=\\"653.0\\" x2=\\"435.0\\" y2=\\"624.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"431.0\\" y1=\\"595.0\\" x2=\\"422.0\\" y2=\\"576.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"408.0\\" y=\\"545.0\\" />\\n      <QuadTo flexible=\\"true\\" x1=\\"455.5\\" y1=\\"501.5\\" x2=\\"517.0\\" y2=\\"530.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"529.0\\" y1=\\"536.0\\" x2=\\"538.5\\" y2=\\"541.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"548.0\\" y1=\\"547.0\\" x2=\\"561.0\\" y2=\\"559.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"574.0\\" y1=\\"571.0\\" x2=\\"574.0\\" y2=\\"583.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"573.0\\" y1=\\"586.0\\" x2=\\"565.0\\" y2=\\"602.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"557.0\\" y1=\\"618.0\\" x2=\\"552.0\\" y2=\\"640.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"547.0\\" y1=\\"663.0\\" x2=\\"545.5\\" y2=\\"675.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"544.0\\" y1=\\"688.0\\" x2=\\"542.0\\" y2=\\"752.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"541.0\\" y=\\"782.0\\" />\\n      <LineTo flexible=\\"true\\" x=\\"538.0\\" y=\\"860.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"529.0\\" y=\\"1123.0\\" />\\n      <QuadTo flexible=\\"true\\" x1=\\"482.5\\" y1=\\"1206.5\\" x2=\\"436.0\\" y2=\\"1138.0\\" />\\n    </Outline>\\n    <Track>\\n      <MoveTo x=\\"490.0\\" y=\\"556.0\\" />\\n      <MoveTo x=\\"483.0\\" y=\\"1093.0\\" />\\n    </Track>\\n  </Stroke>\\n  <Stroke>\\n    <Outline>\\n      <MoveTo x=\\"673.0\\" y=\\"1197.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"591.0\\" y1=\\"1205.0\\" x2=\\"521.5\\" y2=\\"1209.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"452.0\\" y1=\\"1214.0\\" x2=\\"445.0\\" y2=\\"1214.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"304.0\\" y=\\"1227.0\\" />\\n      <QuadTo flexible=\\"true\\" x1=\\"226.5\\" y1=\\"1196.0\\" x2=\\"303.0\\" y2=\\"1159.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"328.0\\" y1=\\"1155.0\\" x2=\\"342.0\\" y2=\\"1153.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"390.0\\" y=\\"1146.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"436.0\\" y=\\"1138.0\\" />\\n      <LineTo flexible=\\"true\\" x=\\"529.0\\" y=\\"1123.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"559.0\\" y1=\\"1119.0\\" x2=\\"583.5\\" y2=\\"1119.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"608.0\\" y1=\\"1120.0\\" x2=\\"628.0\\" y2=\\"1130.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"674.0\\" y=\\"1151.0\\" />\\n      <QuadTo flexible=\\"true\\" x1=\\"713.5\\" y1=\\"1177.0\\" x2=\\"673.0\\" y2=\\"1197.0\\" />\\n    </Outline>\\n    <Track>\\n      <MoveTo x=\\"353.0\\" y=\\"1186.0\\" />\\n      <MoveTo x=\\"673.0\\" y=\\"1173.0\\" />\\n    </Track>\\n  </Stroke>\\n  <Stroke>\\n    <Outline>\\n      <MoveTo x=\\"1360.0\\" y=\\"453.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1307.0\\" y1=\\"460.0\\" x2=\\"1276.5\\" y2=\\"465.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1246.0\\" y1=\\"470.0\\" x2=\\"1192.5\\" y2=\\"481.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1139.0\\" y1=\\"492.0\\" x2=\\"1110.0\\" y2=\\"500.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1081.0\\" y1=\\"508.0\\" x2=\\"1068.0\\" y2=\\"508.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1046.0\\" y1=\\"509.0\\" x2=\\"1009.0\\" y2=\\"493.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"972.0\\" y1=\\"477.0\\" x2=\\"957.0\\" y2=\\"460.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"942.0\\" y1=\\"443.0\\" x2=\\"945.5\\" y2=\\"435.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"949.0\\" y1=\\"428.0\\" x2=\\"974.0\\" y2=\\"424.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"1037.0\\" y=\\"415.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"1138.0\\" y=\\"401.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1158.0\\" y1=\\"399.0\\" x2=\\"1271.0\\" y2=\\"381.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"1438.0\\" y=\\"356.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1504.0\\" y1=\\"346.0\\" x2=\\"1561.0\\" y2=\\"336.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1618.0\\" y1=\\"327.0\\" x2=\\"1658.0\\" y2=\\"322.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1698.0\\" y1=\\"317.0\\" x2=\\"1729.0\\" y2=\\"308.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1760.0\\" y1=\\"300.0\\" x2=\\"1769.0\\" y2=\\"299.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1788.0\\" y1=\\"299.0\\" x2=\\"1808.5\\" y2=\\"306.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1829.0\\" y1=\\"314.0\\" x2=\\"1866.0\\" y2=\\"329.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1903.0\\" y1=\\"344.0\\" x2=\\"1918.0\\" y2=\\"356.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1933.0\\" y1=\\"368.0\\" x2=\\"1932.5\\" y2=\\"377.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1932.0\\" y1=\\"386.0\\" x2=\\"1915.5\\" y2=\\"399.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1899.0\\" y1=\\"412.0\\" x2=\\"1827.0\\" y2=\\"414.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"1774.0\\" y=\\"416.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"1661.0\\" y=\\"422.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1551.0\\" y1=\\"428.0\\" x2=\\"1549.0\\" y2=\\"428.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"1460.0\\" y=\\"436.0\\" />\\n      <LineTo flexible=\\"true\\" x=\\"1360.0\\" y=\\"453.0\\" />\\n    </Outline>\\n    <Track>\\n      <MoveTo x=\\"1020.0\\" y=\\"430.0\\" />\\n      <MoveTo x=\\"1920.0\\" y=\\"353.0\\" />\\n    </Track>\\n  </Stroke>\\n  <Stroke>\\n    <Outline>\\n      <MoveTo x=\\"1460.0\\" y=\\"436.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1484.0\\" y1=\\"451.0\\" x2=\\"1506.5\\" y2=\\"464.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1529.0\\" y1=\\"478.0\\" x2=\\"1531.0\\" y2=\\"489.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1533.0\\" y1=\\"500.0\\" x2=\\"1524.0\\" y2=\\"525.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1515.0\\" y1=\\"549.0\\" x2=\\"1512.5\\" y2=\\"590.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1510.0\\" y1=\\"631.0\\" x2=\\"1510.0\\" y2=\\"673.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"1510.0\\" y=\\"745.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"1507.0\\" y=\\"1088.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1506.0\\" y1=\\"1139.0\\" x2=\\"1509.5\\" y2=\\"1246.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1513.0\\" y1=\\"1354.0\\" x2=\\"1513.0\\" y2=\\"1411.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1512.0\\" y1=\\"1486.0\\" x2=\\"1506.5\\" y2=\\"1537.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1501.0\\" y1=\\"1588.0\\" x2=\\"1488.0\\" y2=\\"1625.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1475.0\\" y1=\\"1663.0\\" x2=\\"1451.5\\" y2=\\"1694.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1428.0\\" y1=\\"1726.0\\" x2=\\"1404.5\\" y2=\\"1740.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1381.0\\" y1=\\"1754.0\\" x2=\\"1366.0\\" y2=\\"1751.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1349.0\\" y1=\\"1749.0\\" x2=\\"1324.5\\" y2=\\"1717.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1300.0\\" y1=\\"1686.0\\" x2=\\"1281.0\\" y2=\\"1665.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1262.0\\" y1=\\"1644.0\\" x2=\\"1226.0\\" y2=\\"1607.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1190.0\\" y1=\\"1570.0\\" x2=\\"1176.0\\" y2=\\"1559.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"1123.0\\" y=\\"1518.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1110.0\\" y1=\\"1509.0\\" x2=\\"1118.0\\" y2=\\"1499.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1126.0\\" y1=\\"1490.0\\" x2=\\"1138.0\\" y2=\\"1492.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"1196.0\\" y=\\"1506.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"1293.0\\" y=\\"1538.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1327.0\\" y1=\\"1547.0\\" x2=\\"1343.0\\" y2=\\"1538.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1360.0\\" y1=\\"1529.0\\" x2=\\"1368.5\\" y2=\\"1498.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1377.0\\" y1=\\"1467.0\\" x2=\\"1383.5\\" y2=\\"1406.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1390.0\\" y1=\\"1346.0\\" x2=\\"1393.0\\" y2=\\"1289.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1396.0\\" y1=\\"1233.0\\" x2=\\"1395.5\\" y2=\\"1108.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1395.0\\" y1=\\"984.0\\" x2=\\"1396.5\\" y2=\\"866.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1398.0\\" y1=\\"749.0\\" x2=\\"1398.0\\" y2=\\"723.0\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1396.0\\" y1=\\"657.0\\" x2=\\"1388.0\\" y2=\\"591.5\\" />\\n      <QuadTo flexible=\\"false\\" x1=\\"1380.0\\" y1=\\"526.0\\" x2=\\"1373.0\\" y2=\\"500.0\\" />\\n      <LineTo flexible=\\"false\\" x=\\"1360.0\\" y=\\"453.0\\" />\\n      <QuadTo flexible=\\"true\\" x1=\\"1400.0\\" y1=\\"411.5\\" x2=\\"1460.0\\" y2=\\"436.0\\" />\\n    </Outline>\\n    <Track>\\n      <MoveTo x=\\"1430.0\\" y=\\"485.0\\" />\\n      <MoveTo x=\\"1455.0\\" y=\\"760.0\\" />\\n      <MoveTo x=\\"1455.0\\" y=\\"1195.0\\" />\\n      <MoveTo x=\\"1465.0\\" y=\\"1550.0\\" />\\n      <MoveTo x=\\"1355.0\\" y=\\"1695.0\\" />\\n      <MoveTo x=\\"1155.0\\" y=\\"1525.0\\" />\\n    </Track>\\n  </Stroke>\\n</Word>\\n\\n";

var bat=[];
</script></body></html>`;

describe("toDecimalCodepoint / toHexCodepoint", () => {
  it("matches moedict.tw's existing stroke-json codepoint convention", () => {
    // U+753A = decimal 30010; handleStrokeAPI.ts / StrokeAnimation.tsx both
    // key stroke-json objects by lowercase hex codepoint ("753a").
    expect(toDecimalCodepoint("町")).toBe(30010);
    expect(toHexCodepoint("町")).toBe("753a");
  });
});

describe("extractInlineStrokeXml", () => {
  it("extracts and unescapes the embedded stroke XML for 町 from a real MOE page", () => {
    const xml = extractInlineStrokeXml(MOE_DICTVIEW_HTML_FIXTURE, "町");
    expect(xml).toBeTruthy();
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('unicode="町"');
    expect(xml).toContain("<Stroke>");
  });

  it("returns null when the page has no embedded XML for a different id", () => {
    // 一 (U+4E00, decimal 19968) is not embedded in this fixture.
    expect(extractInlineStrokeXml(MOE_DICTVIEW_HTML_FIXTURE, "一")).toBeNull();
  });

  it("throws on a unicode-attribute mismatch instead of silently returning wrong-character data", () => {
    // Regression guard for the failure mode this whole investigation was
    // originally worried about: a codepoint/encoding mismatch silently
    // serving one character's stroke data under a different character's
    // title (the plausible root cause of the *original* 2018 "wrong stroke
    // order" screenshot on the now-retired moedict-webkit frontend).
    //
    // The fixture stores the XML as an escaped JS string literal (the exact
    // shape MOE's own page emits: `unicode=\"町\"`), so the tamper must
    // target that escaped form, not the post-unescape XML text.
    const tamperedHtml = MOE_DICTVIEW_HTML_FIXTURE.replace('unicode=\\"町\\"', 'unicode=\\"聖\\"');
    expect(tamperedHtml).not.toBe(MOE_DICTVIEW_HTML_FIXTURE);
    expect(() => extractInlineStrokeXml(tamperedHtml, "町")).toThrow(/unicode attribute mismatch/);
  });
});

describe("parseMoeStrokeXml", () => {
  const xml = extractInlineStrokeXml(MOE_DICTVIEW_HTML_FIXTURE, "町");

  it("produces exactly 7 strokes, matching 町's dictionary stroke_count (田 5 + 丁 2)", () => {
    const strokes = parseMoeStrokeXml(xml);
    expect(strokes).toHaveLength(7);
  });

  it("matches the moedict.tw stroke-json schema used by jquery.strokeWords.js's jsonFromXml", () => {
    const strokes = parseMoeStrokeXml(xml);
    for (const stroke of strokes) {
      expect(stroke).toHaveProperty("outline");
      expect(stroke).toHaveProperty("track");
      expect(Array.isArray(stroke.outline)).toBe(true);
      expect(Array.isArray(stroke.track)).toBe(true);
      for (const cmd of stroke.outline) {
        expect(["M", "L", "Q", "C"]).toContain(cmd.type);
        if (cmd.type === "M" || cmd.type === "L") {
          expect(typeof cmd.x).toBe("number");
          expect(typeof cmd.y).toBe("number");
        } else if (cmd.type === "Q") {
          expect(cmd.begin).toEqual({ x: expect.any(Number), y: expect.any(Number) });
          expect(cmd.end).toEqual({ x: expect.any(Number), y: expect.any(Number) });
        } else if (cmd.type === "C") {
          expect(cmd.begin).toEqual({ x: expect.any(Number), y: expect.any(Number) });
          expect(cmd.mid).toEqual({ x: expect.any(Number), y: expect.any(Number) });
          expect(cmd.end).toEqual({ x: expect.any(Number), y: expect.any(Number) });
        }
      }
    }
  });

  it("first stroke starts with a MoveTo at the exact MOE-authored coordinates (no silent reprojection)", () => {
    const strokes = parseMoeStrokeXml(xml);
    expect(strokes[0].outline[0]).toEqual({ type: "M", x: 304, y: 1227 });
  });

  it("splits into a 5-stroke left component (田, x < 950) and a 2-stroke right component (丁, x > 950)", () => {
    // Coarse structural sanity check distinguishing this from the kind of
    // wrong-character/garbled composite the original issue reported: 町 =
    // 田 (5 strokes) + 丁 (2 strokes), and MOE's coordinate space places 田
    // in roughly the left half and 丁 in the right half of the em-square.
    const strokes = parseMoeStrokeXml(xml);
    const maxX = (s: { outline: Array<{ x?: number; end?: { x: number } }> }): number =>
      Math.max(...s.outline.map((c) => c.x ?? c.end?.x ?? 0));
    const left = strokes.filter((s) => maxX(s) < 950);
    const right = strokes.filter((s) => maxX(s) >= 950);
    expect(left).toHaveLength(5);
    expect(right).toHaveLength(2);
  });
});

describe("fetchAndConvertMoeStroke", () => {
  it("end-to-end: fetches, extracts, and converts using a mocked dictView.jsp response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      expect(url).toBe("https://stroke-order.learningweb.moe.edu.tw/dictView.jsp?ID=30010");
      return new Response(MOE_DICTVIEW_HTML_FIXTURE, { status: 200 });
    }) as typeof fetch;
    try {
      const result = await fetchAndConvertMoeStroke("町");
      if (result === null) throw new Error("expected fetchAndConvertMoeStroke to resolve a result");
      expect(result.json).toHaveLength(7);
      expect(result.sourceUrl).toBe(
        "https://stroke-order.learningweb.moe.edu.tw/dictView.jsp?ID=30010",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns null (not a thrown error) when the upstream page has no stroke XML for the character", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("<html><body>no stroke data here</body></html>", { status: 200 });
    try {
      const result = await fetchAndConvertMoeStroke("町");
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces upstream HTTP failures instead of masking them", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("", { status: 404 });
    try {
      await expect(fetchAndConvertMoeStroke("町")).rejects.toThrow(/HTTP 404/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
