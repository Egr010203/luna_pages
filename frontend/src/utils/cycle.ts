export const daysBetween = (startDate: string | Date, endDate: string | Date = new Date()): number => {
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);

  const end = new Date(endDate);
  end.setHours(0, 0, 0, 0);

  const diffTime = end.getTime() - start.getTime();
  return Math.floor(diffTime / (1000 * 60 * 60 * 24));
};

export const getCycleDay = (startDate: string | Date): number => {
  return daysBetween(startDate, new Date()) + 1;
};
