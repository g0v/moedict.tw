import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRadicalTooltip } from '../hooks/useRadicalTooltip';
import { cleanTextForTTS, speakText } from '../utils/tts-utils';
import { getAudioUrl, playAudioUrl } from '../utils/audio-utils';
import { rightAngle } from '../utils/ruby2hruby';
import { decorateRuby } from '../utils/bopomofo-pinyin-utils';
import { addStarWord, addToLRU, hasStarWord, removeStarWord, writeLastLookup } from '../utils/word-record-utils';
import { fetchDictionaryEntry, readCachedDictionaryEntry } from '../utils/dictionary-cache';
import { setCurrentXrefs } from '../utils/xref-switch-utils';
import { StrokeAnimation } from '../components/StrokeAnimation';

export type DictionaryLang = 'a' | 't' | 'h' | 'c';

interface Definition {
  type?: string;
  def?: string;
  example?: string[] | string;
  quote?: string[] | string;
  link?: string[] | string;
  synonyms?: string[] | string;
  antonyms?: string[] | string;
}

interface Heteronym {
  bopomofo?: string;
  pinyin?: string;
  trs?: string;
  alt?: string;
  audio_id?: string;
  definitions?: Definition[];
}

interface DictionaryAPIResponse {
  title?: string;
  heteronyms?: Heteronym[];
  radical?: string;
  stroke_count?: number;
  non_radical_stroke_count?: number;
  translation?: Record<string, string | string[]>;
  English?: string | string[];
  Deutsch?: string | string[];
  francais?: string | string[];
  xrefs?: Array<{ lang: DictionaryLang; words: string[] }>;
}

interface DictionaryErrorResponse {
  message?: string;
  terms?: string[];
}

interface DictionaryState {
  loading: boolean;
  entry: DictionaryAPIResponse | null;
  terms: string[];
  error: string | null;
}

interface DictionaryPageProps {
  word?: string;
  lang: DictionaryLang;
}

function groupDefinitions(definitions: Definition[]): Map<string, Definition[]> {
  const grouped = new Map<string, Definition[]>();
  for (const definition of definitions) {
    const key = String(definition.type || '');
    const list = grouped.get(key) ?? [];
    list.push(definition);
    grouped.set(key, list);
  }
  return grouped;
}

function splitPartOfSpeech(typeText: string): string[] {
  if (!typeText) return [];
  return typeText
    .split(',')
    .map((tag) => untag(tag).trim())
    .filter(Boolean);
}

function toStringArray(value: string[] | string | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value];
}

function normalizeHref(rawHref: string): string | null {
  const href = rawHref.trim();
  if (!href) return null;
  if (/^(?:https?:|mailto:|tel:)/i.test(href)) return null;
  if (href.startsWith('/')) return href;

  let token = href;
  token = token.replace(/^\.\//, '');
  token = token.replace(/^#/, '');
  token = token.trim();
  if (!token) return null;
  return `/${token}`;
}

function untag(input: string): string {
  return input.replace(/<[^>]*>/g, '');
}

function formatTranslation(value: string[] | string): string {
  return untag(Array.isArray(value) ? value.join(', ') : value);
}

function formatExampleIcon(input: string): string {
  return input.replace('例⃝', '<span class="specific">例</span>');
}

function getLangTokenPrefix(lang: DictionaryLang): string {
  if (lang === 't') return "'";
  if (lang === 'h') return ':';
  if (lang === 'c') return '~';
  return '';
}

function getLangName(lang: DictionaryLang): string {
  if (lang === 't') return '台語';
  if (lang === 'h') return '客語';
  if (lang === 'c') return '兩岸';
  return '華語';
}

type TTSLabel = '英' | '德' | '法';

function XrefTranslationLine({
  label,
  value,
}: {
  label: TTSLabel;
  value: string | string[];
}) {
  const cleaned = cleanTextForTTS(value);
  const handleClick = (event: MouseEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    if (cleaned.trim()) speakText(label, cleaned);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (cleaned.trim()) speakText(label, cleaned);
    }
  };

  return (
    <div className="xref-line">
      <span className="fw_lang">{label}</span>
      <span className="fw_def" role="button" tabIndex={0} onClick={handleClick} onKeyDown={handleKeyDown}>
        {formatTranslation(value)}
      </span>
    </div>
  );
}

const CJK_RADICALS =
  '⼀一⼁丨⼂丶⼃丿⼄乙⼅亅⼆二⼇亠⼈人⼉儿⼊入⼋八⼌冂⼍冖⼎冫⼏几⼐凵⼑刀⼒力⼓勹⼔匕⼕匚⼖匸⼗十⼘卜⼙卩⼚厂⼛厶⼜又⼝口⼞囗⼟土⼠士⼡夂⼢夊⼣夕⼤大⼥女⼦子⼧宀⼨寸⼩小⼪尢⼫尸⼬屮⼭山⼮巛⼯工⼰己⼱巾⼲干⼳幺⼴广⼵廴⼶廾⼷弋⼸弓⼹彐⼺彡⼻彳⼼心⼽戈⼾戶⼿手⽀支⽁攴⽂文⽃斗⽄斤⽅方⽆无⽇日⽈曰⽉月⽊木⽋欠⽌止⽍歹⽎殳⽏毋⽐比⽑毛⽒氏⽓气⽔水⽕火⽖爪⽗父⽘爻⽙爿⺦丬⽚片⽛牙⽜牛⽝犬⽞玄⽟玉⽠瓜⽡瓦⽢甘⽣生⽤用⽥田⽦疋⽧疒⽨癶⽩白⽪皮⽫皿⽬目⽭矛⽮矢⽯石⽰示⽱禸⽲禾⽳穴⽴立⽵竹⽶米⽷糸⺰纟⽸缶⽹网⽺羊⽻羽⽼老⽽而⽾耒⽿耳⾀聿⾁肉⾂臣⾃自⾄至⾅臼⾆舌⾇舛⾈舟⾉艮⾊色⾋艸⾌虍⾍虫⾎血⾏行⾐衣⾑襾⾒見⻅见⾓角⾔言⻈讠⾕谷⾖豆⾗豕⾘豸⾙貝⻉贝⾚赤⾛走⾜足⾝身⾞車⻋车⾟辛⾠辰⾡辵⻌辶⾢邑⾣酉⾤釆⾥里⾦金⻐钅⾧長⻓长⾨門⻔门⾩阜⾪隶⾫隹⾬雨⾭靑⾮非⾯面⾰革⾱韋⻙韦⾲韭⾳音⾴頁⻚页⾵風⻛风⾶飛⻜飞⾷食⻠饣⾸首⾹香⾺馬⻢马⾻骨⾼高⾽髟⾾鬥⾿鬯⿀鬲⿁鬼⿂魚⻥鱼⻦鸟⿃鳥⿄鹵⻧卤⿅鹿⿆麥⻨麦⿇麻⿈黃⻩黄⿉黍⿊黑⿋黹⿌黽⻪黾⿍鼎⿎鼓⿏鼠⿐鼻⿑齊⻬齐⿒齒⻮齿⿓龍⻰龙⿔龜⻳龟⿕龠';

function normalizeRadicalChar(input: string): string {
  try {
    if (!input) return '';
    const raw = input.replace(/<[^>]*>/g, '');
    const idx = CJK_RADICALS.indexOf(raw);
    if (idx >= 0 && idx % 2 === 0) {
      const normalized = CJK_RADICALS.charAt(idx + 1) || raw;
      return normalized === '靑' ? '青' : normalized;
    }
    return raw === '靑' ? '青' : raw;
  } catch {
    return input === '靑' ? '青' : input || '';
  }
}

function RadicalGlyph({ char, lang }: { char: string; lang: DictionaryLang }) {
  const ch = normalizeRadicalChar(char);
  const radicalToken = `${lang === 'c' ? '~@' : '@'}${ch}`;
  return (
    <span className="glyph">
      <a
        title="部首檢索"
        className="xref"
        href={`./#${radicalToken}`}
        data-radical-id={radicalToken}
        style={{ color: 'white' }}
      >
        {' '}
        {ch}
      </a>
    </span>
  );
}

export function DictionaryPage({ word, lang }: DictionaryPageProps) {
  const navigate = useNavigate();
  const queryWord = useMemo(() => (word ?? '').trim(), [word]);
  const langTokenPrefix = getLangTokenPrefix(lang);
  const [state, setState] = useState<DictionaryState>({
    loading: false,
    entry: null,
    terms: [],
    error: null,
  });
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
  const [isStarred, setIsStarred] = useState(false);
  const [strokesVisible, setStrokesVisible] = useState(false);
  const storageWord = useMemo(() => untag((state.entry?.title || queryWord || '').trim()), [state.entry?.title, queryWord]);

  // 設定 body 語言 class（同原 $('body').addClass("lang-#LANG")）
  useEffect(() => {
    const langClass = `lang-${lang}`;
    document.body.classList.add(langClass);
    return () => {
      document.body.classList.remove(langClass);
    };
  }, [lang]);

  useRadicalTooltip();

  useEffect(() => {
    if (!queryWord) {
      setState({ loading: false, entry: null, terms: [], error: '未提供字詞' });
      return;
    }

    const applyResponse = (result: { ok: boolean; status: number; data: unknown }) => {
      const payload = result.data as DictionaryAPIResponse | DictionaryErrorResponse;

      if (result.ok) {
        setState({ loading: false, entry: payload as DictionaryAPIResponse, terms: [], error: null });
        return;
      }

      const terms = Array.isArray((payload as DictionaryErrorResponse).terms)
        ? (payload as DictionaryErrorResponse).terms ?? []
        : [];
      const message = (payload as DictionaryErrorResponse).message ?? `查詢失敗 (${result.status})`;
      setState({ loading: false, entry: null, terms, error: terms.length > 0 ? null : message });
    };

    const cached = readCachedDictionaryEntry(queryWord, lang);
    if (cached) {
      setPlayingAudioId(null);
      applyResponse(cached);
      return;
    }

    const controller = new AbortController();
    setState((previous) => ({
      ...previous,
      loading: true,
      terms: [],
      error: null,
    }));
    setPlayingAudioId(null);
    setStrokesVisible(false);

    fetchDictionaryEntry(queryWord, lang, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        applyResponse(result);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : '查詢失敗';
        setState({ loading: false, entry: null, terms: [], error: message });
      });

    return () => {
      controller.abort();
    };
  }, [lang, queryWord]);

  useEffect(() => {
    if (!state.entry) return;
    addToLRU(queryWord, lang);
    writeLastLookup(queryWord, lang);
    setCurrentXrefs(queryWord, lang, state.entry.xrefs ?? []);
  }, [state.entry, queryWord, lang]);

  useEffect(() => {
    if (!state.entry || !storageWord) {
      setIsStarred(false);
      return;
    }
    setIsStarred(hasStarWord(lang, storageWord));
  }, [state.entry, storageWord, lang]);

  const toggleStar = useCallback(() => {
    if (!storageWord) return;
    const current = hasStarWord(lang, storageWord);
    if (current) {
      removeStarWord(lang, storageWord);
    } else {
      addStarWord(lang, storageWord);
    }
    setIsStarred(!current);
  }, [lang, storageWord]);

  const onContentClick = (event: MouseEvent<HTMLDivElement>): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const anchor = target.closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href) return;

    const normalized = normalizeHref(href);
    if (!normalized) return;
    event.preventDefault();
    navigate(normalized);
  };

  if (state.error) {
    return (
      <div className="result">
        <h1 className="title">找不到：{queryWord}</h1>
        <div className="entry">
          <div className="entry-item">
            <p className="def">{state.error}</p>
          </div>
        </div>
      </div>
    );
  }

  if (state.terms.length > 0) {
    return (
      <div className="result">
        <h1 className="title">未找到完整詞條：{queryWord}</h1>
        <div className="entry">
          <div className="entry-item">
            <p>可嘗試以下分字：</p>
            <ul>
              {state.terms.map((term) => {
                const to = `/${langTokenPrefix}${term}`;
                return (
                  <li key={term}>
                    <a
                      href={to}
                      data-radical-id={`entry:${to}`}
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(to);
                      }}
                    >
                      {term}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>
    );
  }

  const entry = state.entry;
  if (!entry) return null;

  const title = entry.title || queryWord;
  const heteronyms = Array.isArray(entry.heteronyms) ? entry.heteronyms : [];
  const translation = entry.translation ?? {};
  const english = translation.English ?? entry.English;
  const deutsch = translation.Deutsch ?? entry.Deutsch;
  const francais = translation.francais ?? entry.francais;

  return (
    <div className="result" onClick={onContentClick} aria-busy={state.loading}>
      {/* 筆順動畫區域（同原 index.html #strokes 位於 .results 頂部） */}
      <StrokeAnimation title={title} visible={strokesVisible} lang={lang} />

      {heteronyms.map((heteronym, idx) => {
        // const rawPinyin = heteronym.pinyin || heteronym.trs || '';
        // const displayPinyin = convertPinyinByLang(lang, rawPinyin, false);
        // const displayBpmf = heteronym.bopomofo || (lang === 't' ? trsToBpmf(lang, rawPinyin) : '');
        // const parallelPinyin = isParallelPinyin(lang);
        const rubyData = decorateRuby({
          LANG: lang,
          title,
          bopomofo: heteronym.bopomofo,
          pinyin: heteronym.pinyin,
          trs: heteronym.trs,
        });

        const definitions = Array.isArray(heteronym.definitions) ? heteronym.definitions : [];
        const groups = groupDefinitions(definitions);

        return (
          <div key={`${title}-${idx}`} className="entry" style={{ position: 'relative' }}>
            {/* 部首＋筆畫＋筆順動畫按鈕（同原 $char div.radical） */}
            <div className="radical">
              {(entry.radical || entry.stroke_count || entry.non_radical_stroke_count) && (
                <>
                  {entry.radical && <RadicalGlyph char={entry.radical} lang={lang} />}
                  <span className="count">
                    <span className="sym">+</span>
                    {entry.non_radical_stroke_count ?? 0}
                  </span>
                  <span className="count"> = {entry.stroke_count ?? ''}</span>
                  {'\u00A0'}
                </>
              )}
              {/* 紅底鉛筆按鈕（同原 a.iconic-circle.stroke.icon-pencil） */}
              <a
                className="iconic-circle stroke icon-pencil"
                title="筆順動畫"
                style={{ color: 'white' }}
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setStrokesVisible((v) => !v);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    setStrokesVisible((v) => !v);
                  }
                }}
              />
            </div>
            {idx === 0 && (
              <i
                className={`star iconic-color ${isStarred ? 'icon-star' : 'icon-star-empty'}`}
                title={isStarred ? '已加入記錄簿' : '加入字詞記錄簿'}
                style={{ color: '#400', top: '50px', right: '0px', cursor: 'pointer' }}
                data-word={title}
                data-lang={lang}
                role="button"
                tabIndex={0}
                aria-label={isStarred ? '已加入記錄簿' : '加入字詞記錄簿'}
                onClick={(event) => {
                  event.stopPropagation();
                  event.preventDefault();
                  toggleStar();
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleStar();
                  }
                }}
              />
            )}

            <h1 className="title" data-title={title}>
              {(() => {
                const htmlRuby = rubyData.ruby || '';
                if (!htmlRuby) return <span dangerouslySetInnerHTML={{ __html: title }} />;
                const hruby = rightAngle(htmlRuby);
                return <span dangerouslySetInnerHTML={{ __html: hruby }} />;
              })()}
              {rubyData.youyin && <small className="youyin">{rubyData.youyin}</small>}
              {heteronym.audio_id && (
                <span className="audioBlock">
                  <i
                    role="button"
                    tabIndex={0}
                    aria-label={playingAudioId === heteronym.audio_id ? '停止播放' : '播放發音'}
                    className={`${playingAudioId === heteronym.audio_id ? 'icon-stop' : 'icon-play'} playAudio part-of-speech`}
                    title={playingAudioId === heteronym.audio_id ? '停止播放' : '播放發音'}
                    onClick={(event) => {
                      event.stopPropagation();
                      const audioId = heteronym.audio_id!;
                      playAudioUrl(getAudioUrl(lang, audioId), (playing) => {
                        setPlayingAudioId(playing ? audioId : null);
                      });
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        const audioId = heteronym.audio_id!;
                        playAudioUrl(getAudioUrl(lang, audioId), (playing) => {
                          setPlayingAudioId(playing ? audioId : null);
                        });
                      }
                    }}
                  />
                </span>
              )}
            </h1>


            {Array.from(groups.entries()).map(([type, items], groupIdx) => {
              const posTags = splitPartOfSpeech(type);
              return (
                <div key={`${type}-${groupIdx}`} className="entry-item">
                  {posTags.map((tag) => (
                    <span key={`${type}-${tag}`} className="part-of-speech">
                      {tag}
                    </span>
                  ))}
                  <ol className={posTags.length > 0 ? 'margin-modified' : undefined}>
                    {items.map((def, defIdx) => (
                      <li key={`${type}-${defIdx}`}>
                        {def.def ? (
                          <p className="definition">
                            <span className="def" dangerouslySetInnerHTML={{ __html: def.def }} />
                          </p>
                        ) : null}
                        {toStringArray(def.example).map((text, exampleIdx) => (
                          <div
                            key={`example-${exampleIdx}`}
                            className="example"
                            dangerouslySetInnerHTML={{ __html: formatExampleIcon(text) }}
                          />
                        ))}
                        {toStringArray(def.quote).map((text, quoteIdx) => (
                          <div key={`quote-${quoteIdx}`} className="quote" dangerouslySetInnerHTML={{ __html: text }} />
                        ))}
                        {toStringArray(def.link).map((text, linkIdx) => (
                          <div key={`link-${linkIdx}`} className="quote" dangerouslySetInnerHTML={{ __html: text }} />
                        ))}
                        {toStringArray(def.synonyms).length > 0 && (
                          <div className="synonyms">
                            <span className="part-of-speech">似</span>
                            <span>{untag(toStringArray(def.synonyms).join('、').replace(/,/g, '、'))}</span>
                          </div>
                        )}
                        {toStringArray(def.antonyms).length > 0 && (
                          <div className="antonyms">
                            <span className="part-of-speech">反</span>
                            <span>{untag(toStringArray(def.antonyms).join('、').replace(/,/g, '、'))}</span>
                          </div>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              );
            })}
          </div>
        );
      })}

      {(english || deutsch || francais) && (
        <div className="xrefs">
          {english && <XrefTranslationLine label="英" value={english} />}
          {deutsch && <XrefTranslationLine label="德" value={deutsch} />}
          {francais && <XrefTranslationLine label="法" value={francais} />}
        </div>
      )}

      {entry.xrefs && entry.xrefs.length > 0 && (
        <div className="xrefs">
          {entry.xrefs.map((xref) => (
            <div key={xref.lang} className="xref-line">
              <span className="xref part-of-speech">{getLangName(xref.lang)}</span>
              <span className="xref">
                {xref.words.map((xrefWord, idx) => {
                  const to = `/${getLangTokenPrefix(xref.lang)}${xrefWord}`;
                  return (
                    <span key={`${xref.lang}-${xrefWord}-${idx}`}>
                      {idx > 0 ? '、' : ''}
                      <a
                        href={to}
                        data-radical-id={`entry:${to}`}
                        onClick={(event) => {
                          event.preventDefault();
                          navigate(to);
                        }}
                      >
                        {xrefWord}
                      </a>
                    </span>
                  );
                })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
