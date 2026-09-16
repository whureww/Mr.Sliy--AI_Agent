/**
 * MySQL 连接失败指数退避（熔断）单元测试
 * mock mysql2/promise，不建立真实连接
 */

jest.mock('mysql2/promise', () => ({
  createConnection: jest.fn()
}));

const mysql = require('mysql2/promise');
const mod = require('../../src/utils/mysql');
const { logger } = require('../../src/utils/logger');

const cfgFor = (host) => ({ host, port: 3306, user: 'u', password: 'p', database: 'db' });

const mkErr = (errno, code, msg) => {
  const e = new Error(msg || code);
  e.errno = errno;
  e.code = code;
  return e;
};
const okConn = () =>
  mysql.createConnection.mockResolvedValue({
    execute: jest.fn().mockResolvedValue([[]]),
    end: jest.fn().mockResolvedValue()
  });
const okConnObj = () => ({ execute: jest.fn().mockResolvedValue([[]]), end: jest.fn().mockResolvedValue() });
const connRejectingExecute = (err) => ({
  execute: jest.fn().mockRejectedValue(err),
  end: jest.fn().mockResolvedValue()
});
const failConn = (msg) => mysql.createConnection.mockRejectedValue(new Error(msg));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(logger, 'warn').mockImplementation(() => {});
  jest.spyOn(logger, 'debug').mockImplementation(() => {});
  jest.spyOn(logger, 'info').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ensureDatabaseExists 指数退避', () => {
  test('首次失败：warn 一次，并进入退避期', async () => {
    failConn('connect EHOSTUNREACH');
    const cfg = cfgFor('host-a');
    await expect(mod.ensureDatabaseExists(cfg)).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/第 1 次/);

    // 退避期内再次调用：不建连接、无新日志
    const attempts = mysql.createConnection.mock.calls.length;
    await expect(mod.ensureDatabaseExists(cfg)).resolves.toBe(false);
    expect(mysql.createConnection.mock.calls.length).toBe(attempts);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('force 选项绕过退避（用户主动测试）', async () => {
    failConn('connect EHOSTUNREACH');
    const cfg = cfgFor('host-b');
    await mod.ensureDatabaseExists(cfg); // 首败
    const attempts = mysql.createConnection.mock.calls.length;
    await expect(mod.ensureDatabaseExists(cfg, { force: true })).resolves.toBe(false);
    expect(mysql.createConnection.mock.calls.length).toBe(attempts + 1);
  });

  test('连续失败第二次：降级为 debug，不再 warn', async () => {
    failConn('Access denied for user');
    const cfg = cfgFor('host-c');
    await mod.ensureDatabaseExists(cfg, { force: true }); // 第 1 次
    logger.warn.mockClear();
    await mod.ensureDatabaseExists(cfg, { force: true }); // 第 2 次
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringMatching(/第 2 次/));
  });

  test('恢复成功：计数清零并输出恢复日志', async () => {
    failConn('connect ETIMEDOUT');
    const cfg = cfgFor('host-d');
    await mod.ensureDatabaseExists(cfg, { force: true }); // 失败 1 次

    okConn();
    await expect(mod.ensureDatabaseExists(cfg, { force: true })).resolves.toBe(true);
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/已恢复/));
    // 成功后计数清零：再次成功走常规日志
    logger.info.mockClear();
    await expect(mod.ensureDatabaseExists(cfg)).resolves.toBe(true);
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/确保数据库存在/));
  });

  test('更换连接配置：重新计数', async () => {
    failConn('connect EHOSTUNREACH');
    await mod.ensureDatabaseExists(cfgFor('host-e'), { force: true }); // host-e 失败 1 次
    // 换 host：计数重置，再次失败应重新 warn 第 1 次
    logger.warn.mockClear();
    await mod.ensureDatabaseExists(cfgFor('host-f'), { force: true });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/第 1 次/);
  });

  test('配置缺失直接返回 false', async () => {
    await expect(mod.ensureDatabaseExists(null)).resolves.toBe(false);
    await expect(mod.ensureDatabaseExists({ host: 'x' })).resolves.toBe(false);
    expect(mysql.createConnection).not.toHaveBeenCalled();
  });

  test('无建库权限(1044)但目标库可直连：降级验证成功', async () => {
    mysql.createConnection.mockImplementation(async (opts = {}) => {
      if (opts.database) return okConnObj(); // 直连验证成功
      return connRejectingExecute(mkErr(1044, 'ER_DBACCESS_DENIED_ERROR', "Access denied for user 'root'@'%' to database 'db'"));
    });
    await expect(mod.ensureDatabaseExists(cfgFor('host-g'), { force: true })).resolves.toBe(true);
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/继续使用现有库/));
  });

  test('无建库权限且目标库不存在(1049)：失败并附处理指引', async () => {
    mysql.createConnection.mockImplementation(async (opts = {}) => {
      if (opts.database) throw mkErr(1049, 'ER_BAD_DB_ERROR', "Unknown database 'db'");
      return connRejectingExecute(mkErr(1044, 'ER_DBACCESS_DENIED_ERROR', 'Access denied'));
    });
    await expect(mod.ensureDatabaseExists(cfgFor('host-h'), { force: true })).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Unknown database/));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/云数据库控制台/));
  });

  test('白名单拒绝(1130)：失败并附白名单指引', async () => {
    mysql.createConnection.mockRejectedValue(mkErr(1130, 'ER_HOST_NOT_PRIVILEGED', "Host '1.2.3.4' is not allowed to connect"));
    await expect(mod.ensureDatabaseExists(cfgFor('host-i'), { force: true })).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/白名单/));
  });

  test('密码错误(1045)：失败并附账号指引', async () => {
    mysql.createConnection.mockRejectedValue(mkErr(1045, 'ER_ACCESS_DENIED_ERROR', 'Access denied for user'));
    await expect(mod.ensureDatabaseExists(cfgFor('host-j'), { force: true })).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/用户名或密码/));
  });
});
