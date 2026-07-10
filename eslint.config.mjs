// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginSecurity from 'eslint-plugin-security';

/**
 * Flat config (ESLint 9) cho extension TypeScript (finding C5).
 *  - @typescript-eslint (type-aware, cần parserOptions.project) + eslint-plugin-security.
 *  - Bật no-floating-promises (cần thông tin kiểu).
 *  - Tắt no-unused-vars lõi, dùng @typescript-eslint/no-unused-vars với quy ước
 *    bỏ qua tên bắt đầu bằng '_' (tham số/biến cố ý không dùng).
 *  - Chỉ lint mã nguồn TS trong src/ và media/; bỏ qua build output, test/ và
 *    các file cấu hình JS (không thuộc tsconfig project).
 */
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'out/**',
      'test/**',
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  pluginSecurity.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // security/detect-object-injection: tắt toàn cục. Rule này bắn ở gần như
      // MỌI truy cập member bằng ngoặc ([]) và trong repo này tất cả điểm bắn là
      // truy cập theo chỉ số mảng hoặc object cục bộ (matches[i], segs, map dựng
      // tại chỗ...) — không có sink nào nhận key do người dùng/bên ngoài điều
      // khiển. Giữ bật sẽ là ~28 cảnh báo false-positive, che lấp cảnh báo thật.
      'security/detect-object-injection': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  }
);
