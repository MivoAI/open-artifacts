export type AppEnvironment = 'development' | 'test' | 'production';

export const readAppEnvironment = (): AppEnvironment => {
  const value = process.env.NODE_ENV;
  if (value === 'production' || value === 'test') return value;
  return 'development';
};
