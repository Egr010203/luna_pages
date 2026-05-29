import { useEffect, useState, useRef, useCallback } from 'react';
import Calendar from 'react-calendar';
import 'react-calendar/dist/Calendar.css';
import { initializeAssistant } from './utils/assistant';
import { getCycleDay } from './utils/cycle';
import { getMockLLMAdvice } from './utils/llm';
import './App.css';

interface Cycle {
  startDate: string;
  endDate: string | null;
}

// ─── Вспомогательные функции для работы с циклами ───────────────────────────

/** Нормализует дату до полуночи (убирает время) */
const toMidnight = (d: Date): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Строка ISO → объект Date (без учёта времени) */
const isoToDay = (iso: string): Date => toMidnight(new Date(iso));

/** Date → строка ISO с полуночью UTC (сохраняем дату, не смещение) */
const dayToISO = (d: Date): string =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();

/**
 * Сортирует циклы по дате начала и схлопывает пересечения:
 * если новый цикл начинается раньше конца предыдущего — предыдущий обрезается.
 */
const normalizeCycles = (list: Cycle[]): Cycle[] => {
  const sorted = [...list].sort(
    (a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime()
  );

  const result: Cycle[] = [];
  for (const cur of sorted) {
    const prev = result[result.length - 1];
    if (prev && prev.endDate === null) {
      // Предыдущий открытый цикл — закрываем на день до начала текущего
      const curStart = isoToDay(cur.startDate);
      const prevStart = isoToDay(prev.startDate);
      if (curStart.getTime() > prevStart.getTime()) {
        // Закрываем в день перед текущим стартом
        const closeDate = new Date(curStart);
        closeDate.setDate(closeDate.getDate() - 1);
        prev.endDate = dayToISO(closeDate);
      } else {
        // Тот же день — удаляем предыдущий фантом
        result.pop();
      }
    } else if (prev && prev.endDate !== null) {
      const prevEnd = isoToDay(prev.endDate);
      const curStart = isoToDay(cur.startDate);
      // Новый цикл начинается до или в тот же день, что заканчивается предыдущий
      if (curStart.getTime() <= prevEnd.getTime()) {
        // Обрезаем предыдущий
        const closeDate = new Date(curStart);
        closeDate.setDate(closeDate.getDate() - 1);
        if (closeDate.getTime() >= isoToDay(prev.startDate).getTime()) {
          prev.endDate = dayToISO(closeDate);
        } else {
          // Полное поглощение — удаляем
          result.pop();
        }
      }
    }
    result.push({ startDate: cur.startDate, endDate: cur.endDate });
  }
  return result;
};

/**
 * Вычисляет «активный» цикл — последний без endDate или
 * цикл у которого endDate >= сегодня (открыт сегодня).
 */
const getActiveCycle = (cycles: Cycle[]): Cycle | null => {
  const last = cycles[cycles.length - 1];
  if (!last) return null;
  if (last.endDate === null) return last;
  // Если конец цикла в будущем или сегодня — тоже считаем активным для UI
  if (new Date(last.endDate).getTime() >= toMidnight(new Date()).getTime()) return last;
  return null;
};

// ─── Компонент ───────────────────────────────────────────────────────────────

export const App = () => {
  const [cycles, setCycles] = useState<Cycle[]>(() => {
    const stored = localStorage.getItem('cycles');
    if (stored) {
      try {
        return normalizeCycles(JSON.parse(stored));
      } catch {
        console.error('[Luna] Не удалось разобрать циклы из localStorage');
      }
    }
    // Миграция старого формата
    const oldStart = localStorage.getItem('cycleStartDate');
    const oldEnd = localStorage.getItem('cycleEndDate');
    if (oldStart) {
      const migrated = normalizeCycles([{ startDate: oldStart, endDate: oldEnd ?? null }]);
      localStorage.setItem('cycles', JSON.stringify(migrated));
      localStorage.removeItem('cycleStartDate');
      localStorage.removeItem('cycleEndDate');
      return migrated;
    }
    return [];
  });

  const [adviceText, setAdviceText] = useState<string>('');
  const [isAnimatingAdvice, setIsAnimatingAdvice] = useState(false);
  const [currentViewDate, setCurrentViewDate] = useState<Date>(new Date());
  const [statusMessage, setStatusMessage] = useState<string>('');

  const activeCycle = getActiveCycle(cycles);
  const isCycleActive = Boolean(activeCycle && activeCycle.endDate === null);

  // ref — чтобы замыкание в initializeAssistant всегда видело актуальный список
  const cyclesRef = useRef(cycles);
  useEffect(() => { cyclesRef.current = cycles; }, [cycles]);

  const assistantRef = useRef<ReturnType<typeof initializeAssistant> | null>(null);

  // ── Сохраняет циклы в state + localStorage с нормализацией ──────────────
  const saveCycles = useCallback((newList: Cycle[]) => {
    const normalized = normalizeCycles(newList);
    setCycles(normalized);
    localStorage.setItem('cycles', JSON.stringify(normalized));
    return normalized;
  }, []);

  // ── Анимация совета ──────────────────────────────────────────────────────
  const updateAdvice = (text: string) => {
    setIsAnimatingAdvice(false);
    setTimeout(() => {
      setAdviceText(text);
      setIsAnimatingAdvice(true);
    }, 10);
  };

  // ── Показать статусное сообщение на 4 секунды ────────────────────────────
  const showStatus = (msg: string) => {
    setStatusMessage(msg);
    setTimeout(() => setStatusMessage(''), 4000);
  };

  // ── Инициализация Sber-ассистента ─────────────────────────────────────────
  useEffect(() => {
    try {
      assistantRef.current = initializeAssistant(() => ({
        app_info: {
          applicationId: import.meta.env.VITE_SMARTAPP_APP_ID || 'luna-calendar',
          appversionId: '2.0.0',
        },
        item_selector: { items: [] },
      }));
    } catch (e) {
      console.error('[Luna] Не удалось инициализировать ассистента:', e);
      return;
    }

    // ── Системные типы, которые игнорируем полностью ─────────────────────
    const SYSTEM_TYPES = new Set([
      'insets', 'character', 'feature_launcher', 'tts_state_update',
    ]);

    assistantRef.current.on('data', (cmd: any) => {
      console.log('[Luna] команда от бота →', cmd);

      if (cmd?.type && SYSTEM_TYPES.has(cmd.type)) return;

      // Разбираем action — Sber SDK передаёт smart_app_data
      let action: any = null;
      if (cmd?.type === 'smart_app_data') {
        action = cmd.smart_app_data;
      } else if (cmd?.action) {
        action = cmd.action;
      }

      if (!action?.type) {
        console.log('[Luna] action не распознан:', cmd);
        return;
      }

      console.log('[Luna] action.type =', action.type, 'payload =', action.payload);

      switch (action.type) {

        // ── Начало цикла сейчас ──────────────────────────────────────────
        case 'START_CYCLE': {
          const todayISO = dayToISO(new Date());
          setCycles((prev) => {
            const copy = prev.map(c => ({ ...c }));
            // Закрываем любой открытый цикл сегодняшней датой
            const last = copy[copy.length - 1];
            if (last && !last.endDate) {
              const lastStart = isoToDay(last.startDate);
              const today = toMidnight(new Date());
              if (today.getTime() > lastStart.getTime()) {
                last.endDate = todayISO;
                copy.push({ startDate: todayISO, endDate: null });
              } else {
                // Тот же день — просто переоткрываем
                last.endDate = null;
              }
            } else {
              copy.push({ startDate: todayISO, endDate: null });
            }
            const normalized = normalizeCycles(copy);
            localStorage.setItem('cycles', JSON.stringify(normalized));
            return normalized;
          });
          showStatus('Начало цикла отмечено ✓');
          break;
        }

        // ── Конец цикла сейчас ───────────────────────────────────────────
        case 'END_CYCLE': {
          const todayISO = dayToISO(new Date());
          setCycles((prev) => {
            const copy = prev.map(c => ({ ...c }));
            const last = copy[copy.length - 1];
            if (last && !last.endDate) {
              last.endDate = todayISO;
              const normalized = normalizeCycles(copy);
              localStorage.setItem('cycles', JSON.stringify(normalized));
              return normalized;
            }
            return prev;
          });
          showStatus('Конец цикла отмечен ✓');
          break;
        }

        // ── Начало цикла задним числом ────────────────────────────────────
        case 'START_CYCLE_BACKDATED': {
          const p = action.payload || {};
          const day   = parseInt(p.day)   || new Date().getDate();
          const month = parseInt(p.month) || (new Date().getMonth() + 1);
          const year  = parseInt(p.year)  || new Date().getFullYear();
          const dateObj = new Date(year, month - 1, day);

          if (isNaN(dateObj.getTime())) {
            console.warn('[Luna] Некорректная дата в START_CYCLE_BACKDATED:', p);
            break;
          }

          const isoDate = dayToISO(dateObj);
          setCycles((prev) => {
            const copy = prev.map(c => ({ ...c }));
            copy.push({ startDate: isoDate, endDate: null });
            const normalized = normalizeCycles(copy);
            localStorage.setItem('cycles', JSON.stringify(normalized));
            return normalized;
          });
          // Показываем нужный месяц в календаре
          setCurrentViewDate(new Date(year, month - 1, 1));
          showStatus(`Начало цикла ${day}.${String(month).padStart(2,'0')}.${year} отмечено ✓`);
          break;
        }

        // ── Конец цикла задним числом ─────────────────────────────────────
        case 'END_CYCLE_BACKDATED': {
          const p = action.payload || {};
          const day   = parseInt(p.day)   || new Date().getDate();
          const month = parseInt(p.month) || (new Date().getMonth() + 1);
          const year  = parseInt(p.year)  || new Date().getFullYear();
          const dateObj = new Date(year, month - 1, day);

          if (isNaN(dateObj.getTime())) {
            console.warn('[Luna] Некорректная дата в END_CYCLE_BACKDATED:', p);
            break;
          }

          const isoDate = dayToISO(dateObj);
          setCycles((prev) => {
            const copy = prev.map(c => ({ ...c }));

            // Ищем последний цикл, который начался ДО этой даты и ещё открыт или заканчивается после
            let targetIdx = -1;
            for (let i = copy.length - 1; i >= 0; i--) {
              const start = isoToDay(copy[i].startDate);
              if (start.getTime() <= dateObj.getTime()) {
                targetIdx = i;
                break;
              }
            }

            if (targetIdx !== -1) {
              copy[targetIdx].endDate = isoDate;
            } else if (copy.length > 0 && !copy[copy.length - 1].endDate) {
              // Фолбэк: закрываем последний открытый
              copy[copy.length - 1].endDate = isoDate;
            }

            const normalized = normalizeCycles(copy);
            localStorage.setItem('cycles', JSON.stringify(normalized));
            return normalized;
          });
          setCurrentViewDate(new Date(year, month - 1, 1));
          showStatus(`Конец цикла ${day}.${String(month).padStart(2,'0')}.${year} отмечён ✓`);
          break;
        }

        // ── Бот просит фронт дать совет ───────────────────────────────────
        case 'GET_ADVICE_REQUESTED': {
          const currentCycles = cyclesRef.current;
          const active = getActiveCycle(currentCycles);

          if (!active) {
            // Сообщаем боту — цикл не начат (event NO_CYCLE_STARTED)
            // Sber SDK: sendData с action_id для serverAction
            assistantRef.current?.sendData({
              action: { action_id: 'NO_CYCLE_STARTED' },
            });
          } else {
            const dayNum = getCycleDay(active.startDate);
            updateAdvice('Формирую совет...');
            getMockLLMAdvice(dayNum).then((advice) => {
              updateAdvice(advice);
              // Отправляем боту event ADVICE_READY с параметром advice
              assistantRef.current?.sendData({
                action: {
                  action_id: 'ADVICE_READY',
                  parameters: { advice },
                },
              });
            });
          }
          break;
        }

        // ── Бот озвучивает совет (фронт просто показывает) ────────────────
        case 'SHOW_ADVICE': {
          if (action.parameters?.advice) {
            updateAdvice(action.parameters.advice);
          }
          break;
        }

        // ── Навигация по календарю ────────────────────────────────────────
        case 'NEXT_MONTH':
          setCurrentViewDate((prev) =>
            new Date(prev.getFullYear(), prev.getMonth() + 1, 1)
          );
          break;

        case 'PREV_MONTH':
          setCurrentViewDate((prev) =>
            new Date(prev.getFullYear(), prev.getMonth() - 1, 1)
          );
          break;

        case 'GO_TO_DATE': {
          const p = action.payload || {};
          if (p.month) {
            const m = parseInt(p.month) - 1;
            const y = p.year ? parseInt(p.year) : new Date().getFullYear();
            setCurrentViewDate(new Date(y, m, 1));
          }
          break;
        }

        default:
          console.log('[Luna] Неизвестный action:', action.type);
      }
    });

    return () => {
      assistantRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Раскраска ячеек календаря ────────────────────────────────────────────
  const getTileClassName = ({ date, view }: { date: Date; view: string }) => {
    if (view !== 'month') return null;

    const cellTime = toMidnight(date).getTime();
    const todayTime = toMidnight(new Date()).getTime();
    const classes: string[] = [];

    for (const cycle of cycles) {
      const startTime = isoToDay(cycle.startDate).getTime();
      const endTime = cycle.endDate ? isoToDay(cycle.endDate).getTime() : null;

      if (cellTime === startTime) classes.push('cycle-start');

      if (endTime !== null && cellTime === endTime) classes.push('cycle-end');

      if (endTime !== null) {
        if (cellTime > startTime && cellTime < endTime) classes.push('cycle-range');
      } else {
        // Открытый цикл — закрашиваем до сегодня
        if (cellTime > startTime && cellTime <= todayTime) classes.push('cycle-range');
      }
    }

    return classes.length ? classes.join(' ') : null;
  };

  // ── Ручное управление циклами (кнопки) ───────────────────────────────────
  const handleManualStart = () => {
    const todayISO = dayToISO(new Date());
    const copy = cycles.map(c => ({ ...c }));
    const last = copy[copy.length - 1];
    if (last && !last.endDate) {
      if (isoToDay(last.startDate).getTime() < toMidnight(new Date()).getTime()) {
        last.endDate = todayISO;
      }
    }
    copy.push({ startDate: todayISO, endDate: null });
    saveCycles(copy);
  };

  const handleManualEnd = () => {
    if (!isCycleActive) return;
    const copy = cycles.map(c => ({ ...c }));
    copy[copy.length - 1].endDate = dayToISO(new Date());
    saveCycles(copy);
  };

  // ── Клик по ячейке календаря — ручная отметка дня ────────────────────────
  const handleDayClick = (date: Date) => {
    const clickedISO = dayToISO(date);
    const clickedTime = toMidnight(date).getTime();

    // Проверяем: уже есть цикл на этот день?
    const existsInCycle = cycles.some((c) => {
      const s = isoToDay(c.startDate).getTime();
      const e = c.endDate ? isoToDay(c.endDate).getTime() : toMidnight(new Date()).getTime();
      return clickedTime >= s && clickedTime <= e;
    });

    if (existsInCycle) {
      // Клик по уже отмеченному дню — ничего не делаем (или можно добавить удаление)
      return;
    }

    // Нет активного цикла — начинаем новый задним числом
    const copy = cycles.map(c => ({ ...c }));
    copy.push({ startDate: clickedISO, endDate: null });
    saveCycles(copy);
    setCurrentViewDate(new Date(date.getFullYear(), date.getMonth(), 1));
  };

  // ── Рендер ────────────────────────────────────────────────────────────────
  const lastCycle = cycles[cycles.length - 1];

  return (
    <div className={`app-container ${isCycleActive ? 'bg-cycle' : 'bg-normal'}`}>
      <div id="center">
        <h1>Luna</h1>
        <p className="subtitle">Трекер женского здоровья</p>

        {statusMessage && (
          <div className="status-toast">{statusMessage}</div>
        )}

        <div className="glass-card">
          <Calendar
            activeStartDate={currentViewDate}
            onActiveStartDateChange={({ activeStartDate }) =>
              activeStartDate && setCurrentViewDate(activeStartDate)
            }
            tileClassName={getTileClassName}
            onClickDay={handleDayClick}
            value={activeCycle ? new Date(activeCycle.startDate) : new Date()}
          />
        </div>

        <div className="action-buttons">
          <button
            className="btn-primary"
            onClick={handleManualStart}
            disabled={isCycleActive}
            title="Отметить начало цикла сегодня"
          >
            Начать цикл
          </button>
          <button
            className="btn-secondary"
            onClick={handleManualEnd}
            disabled={!isCycleActive}
            title="Отметить конец цикла сегодня"
          >
            Завершить цикл
          </button>
        </div>

        {adviceText && (
          <div className="advice-container glass-card" style={{ marginTop: '32px' }}>
            <div className={isAnimatingAdvice ? 'advice-fade-enter-active' : 'advice-fade-enter'}>
              <p style={{ fontWeight: 'bold', marginBottom: '8px', color: 'var(--accent)' }}>
                Совет от ассистента
              </p>
              <p className="advice-text">{adviceText}</p>
            </div>
          </div>
        )}

        <div style={{ marginTop: 'auto', paddingTop: '40px', fontSize: '0.9rem', opacity: 0.7 }}>
          <p>
            Статус:{' '}
            {isCycleActive
              ? `Цикл начат ${isoToDay(activeCycle!.startDate).toLocaleDateString('ru-RU')}`
              : 'Нет активного цикла'}
            {!isCycleActive && lastCycle?.endDate &&
              ` · Последний завершён ${isoToDay(lastCycle.endDate).toLocaleDateString('ru-RU')}`}
            <br />
            Всего циклов: {cycles.length}
          </p>
        </div>
      </div>
    </div>
  );
};

export default App;
