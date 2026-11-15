// notify-child.ts — точка входа отсоединённого процесса доставки уведомления.
// Запуск: node --experimental-strip-types notify-child.ts <payload.json>
// Аргумент — путь к payload-файлу (секретов не содержит, файл удаляется после чтения).
import { childMain } from "./notify.ts";

const code = await childMain(process.argv);
process.exit(code);
