import { useEffect, useState, useRef } from 'react';
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

export const App = () => {
  const [cycles, setCycles] = useState<Cycle[]>(() => {
    const stored = localStorage.getItem('cycles');
    if (stored) {
      try {
        return JSON.parse(stored);
      } catch (e) {
        console.error('Failed to parse cycles from localStorage', e);
      }
    }
    const oldStart = localStorage.getItem('cycleStartDate');
    const oldEnd = localStorage.getItem('cycleEndDate');
    if (oldStart) {
      const migrated = [{ startDate: oldStart, endDate: oldEnd }];
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

  const activeCycle = cycles[cycles.length - 1]?.endDate === null ? cycles[cycles.length - 1] : null;
  const cycleRef = useRef(activeCycle?.startDate || null);

  useEffect(() => {
    cycleRef.current = activeCycle?.startDate || null;
  }, [cycles]);

  const saveCycles = (newCycles: Cycle[]) => {
    setCycles(newCycles);
    localStorage.setItem('cycles', JSON.stringify(newCycles));
  };

  const assistantRef = useRef<ReturnType<typeof initializeAssistant> | null>(null);

  const updateAdviceWithAnimation = (text: string) => {
    setIsAnimatingAdvice(false);
    setTimeout(() => {
      setAdviceText(text);
      setIsAnimatingAdvice(true);
    }, 10);
  };

  useEffect(() => {
    try {
      assistantRef.current = initializeAssistant(() => ({
        app_info: {
          applicationId: 'mock-app-id',
          appversionId: '1.0.0'
        },
        item_selector: {
          items: []
        }
      }));
    } catch (e) {
      console.error('[App] Не удалось инициализировать ассистента:', e);
      return;
    }

    assistantRef.current.on('data', (cmd: any) => {
      console.log('====== ВХОДЯЩАЯ КОМАНДА ОТ БОТА ======', cmd);

      // Системные события СберСалют — игнорируем, они не являются командами приложения
      const SYSTEM_TYPES = ['insets', 'character', 'feature_launcher', 'tts_state_update'];
      if (cmd?.type && SYSTEM_TYPES.includes(cmd.type)) {
        console.log(`[System event] Пропускаем системное событие: ${cmd.type}`);
        return;
      }

      // Единственный тип с данными для приложения — smart_app_data
      let action: any = null;
      if (cmd?.type === 'smart_app_data') {
        action = cmd.smart_app_data;
      } else {
        action = cmd?.action || null;
      }

      if (!action || !action.type) {
         console.log('Не найден понятный action в команде', cmd);
         return;
      }

      console.log('=== РАСПОЗНАН ACTION: ===', action.type);

      switch (action.type) {
        case 'START_CYCLE': {
          console.log('Бот прислал команду начать цикл');
          const todayStart = new Date().toISOString();
          setCycles((prevList) => {
             const newList = prevList.map(c => ({ ...c }));
             const last = newList[newList.length - 1];
             if (last && !last.endDate) {
                 last.endDate = todayStart;
             }
             newList.push({ startDate: todayStart, endDate: null });
             localStorage.setItem('cycles', JSON.stringify(newList));
             return newList;
          });
          break;
        }
        case 'END_CYCLE': {
          console.log('Бот прислал команду закончить цикл');
          const todayEnd = new Date().toISOString();
          setCycles((prevList) => {
             const newList = prevList.map(c => ({ ...c }));
             if (newList.length > 0 && !newList[newList.length - 1].endDate) {
                 newList[newList.length - 1].endDate = todayEnd;
                 localStorage.setItem('cycles', JSON.stringify(newList));
             }
             return newList;
          });
          break;
        }
        case 'START_CYCLE_BACKDATED': {
          console.log('Бот прислал команду начать цикл задним числом', action.payload);
          const { day, month, year } = action.payload || {};
          if (day && month) {
            const targetYear = year || new Date().getFullYear();
            const targetDate = new Date(targetYear, month - 1, day);
            const dateStr = targetDate.toISOString();
            
            setCycles((prevList) => {
               const newList = prevList.map(c => ({ ...c }));
               const last = newList[newList.length - 1];
               if (last && !last.endDate) {
                   last.endDate = dateStr;
               }
               newList.push({ startDate: dateStr, endDate: null });
               newList.sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
               localStorage.setItem('cycles', JSON.stringify(newList));
               return newList;
            });
          }
          break;
        }
        case 'END_CYCLE_BACKDATED': {
          console.log('Бот прислал команду закончить цикл задним числом', action.payload);
          const { day, month, year } = action.payload || {};
          if (day && month) {
            const targetYear = year || new Date().getFullYear();
            const targetDate = new Date(targetYear, month - 1, day);
            const dateStr = targetDate.toISOString();
            
            setCycles((prevList) => {
               const newList = prevList.map(c => ({ ...c }));
               if (newList.length > 0 && !newList[newList.length - 1].endDate) {
                   newList[newList.length - 1].endDate = dateStr;
                   localStorage.setItem('cycles', JSON.stringify(newList));
               }
               return newList;
            });
          }
          break;
        }
        case 'GET_ADVICE_REQUESTED': {
          console.log('Бот просит данные для совета. Цикл начат?');
          if (!cycleRef.current) {
            assistantRef.current?.sendData({
               action: { action_id: 'NO_CYCLE_STARTED' }
            });
          } else {
            const currentDay = getCycleDay(cycleRef.current);
            console.log('Отправляем боту ответ: день', currentDay);
            updateAdviceWithAnimation('Формирую совет...');

            getMockLLMAdvice(currentDay).then(advice => {
              updateAdviceWithAnimation(advice);
              assistantRef.current?.sendData({
                 action: { action_id: 'ADVICE_READY', parameters: { advice: advice } }
              });
            });
          }
          break;
        }
        case 'SHOW_ADVICE': {
          console.log('Бот прислал готовый совет от LLM:', action.parameters?.advice);
          if (action.parameters?.advice) {
            updateAdviceWithAnimation(action.parameters.advice);
          }
          break;
        }
        case 'NEXT_MONTH': {
          console.log('Бот прислал команду показать следующий месяц');
          setCurrentViewDate((prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1));
          break;
        }
        case 'PREV_MONTH': {
          console.log('Бот прислал команду показать предыдущий месяц');
          setCurrentViewDate((prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1));
          break;
        }
        case 'GO_TO_DATE': {
          console.log('Бот прислал команду перейти к дате', action.payload);
          if (action.payload && action.payload.month) {
            const targetMonthIndex = parseInt(action.payload.month) - 1;
            const targetYear = action.payload.year ? parseInt(action.payload.year) : new Date().getFullYear();
            setCurrentViewDate(new Date(targetYear, targetMonthIndex, 1));
          }
          break;
        }
        default:
          console.log('Неизвестный тип action:', action.type);
          break;
      }
    });

    return () => {
      assistantRef.current = null;
    };
  }, []);

  const getTileClassName = ({ date, view }: { date: Date, view: string }) => {
    if (view === 'month') {
      const cellTime = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
      const todayTime = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();
      
      const classes: string[] = [];

      cycles.forEach((cycle) => {
        const startDateObj = new Date(cycle.startDate);
        const startTime = new Date(startDateObj.getFullYear(), startDateObj.getMonth(), startDateObj.getDate()).getTime();
        
        let endTime = null;
        if (cycle.endDate) {
          const endDateObj = new Date(cycle.endDate);
          endTime = new Date(endDateObj.getFullYear(), endDateObj.getMonth(), endDateObj.getDate()).getTime();
        }

        if (cellTime === startTime) {
          classes.push('cycle-start');
        }

        if (endTime !== null && cellTime === endTime) {
          classes.push('cycle-end');
        }

        if (endTime !== null) {
          if (cellTime > startTime && cellTime < endTime) {
            classes.push('cycle-range');
          }
        } else {
          if (cellTime > startTime && cellTime <= todayTime) {
            classes.push('cycle-range');
          }
        }
      });

      return classes.join(' ');
    }
    return null;
  };

  const handleManualStart = () => {
    const todayStart = new Date().toISOString();
    const newList = [...cycles, { startDate: todayStart, endDate: null }];
    saveCycles(newList);
  };

  const handleManualEnd = () => {
    if (cycles.length === 0 || cycles[cycles.length - 1].endDate) return;
    const todayEnd = new Date().toISOString();
    const newList = [...cycles];
    newList[newList.length - 1].endDate = todayEnd;
    saveCycles(newList);
  };

  const isCycleActive = Boolean(activeCycle);

  return (
    <div className={`app-container ${isCycleActive ? 'bg-cycle' : 'bg-normal'}`}>
      <div id="center">
        <h1>Luna</h1>
        <p className="subtitle">Трекер женского здоровья</p>

        <div className="glass-card">
          <Calendar
            activeStartDate={currentViewDate}
            onActiveStartDateChange={({ activeStartDate }) => activeStartDate && setCurrentViewDate(activeStartDate)}
            tileClassName={getTileClassName}
            value={activeCycle ? new Date(activeCycle.startDate) : new Date()}
          />
        </div>

        <div className="action-buttons">
          <button className="btn-primary" onClick={handleManualStart} disabled={isCycleActive}>
            Начать цикл
          </button>
          <button className="btn-secondary" onClick={handleManualEnd} disabled={!isCycleActive}>
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
            Статус: {isCycleActive ? `Текущий цикл начат ${new Date(activeCycle!.startDate).toLocaleDateString()}` : 'Нет активного цикла'}
            {!isCycleActive && cycles.length > 0 && ` · Последний завершен ${new Date(cycles[cycles.length - 1].endDate!).toLocaleDateString()}`}
            <br/>Всего циклов: {cycles.length}
          </p>
        </div>
      </div>
    </div>
  );
};

export default App;

