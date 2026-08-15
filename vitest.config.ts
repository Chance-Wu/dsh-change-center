import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    // 每个测试文件独立进程:隔离 process.env(DSH_HOME 等)——threads 池共享线程
    // env,并发测试会互相污染导致真实文件系统测试偶发失败。
    pool: 'forks',
  },
})
