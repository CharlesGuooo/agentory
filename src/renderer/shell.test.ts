import { describe, expect, it } from "vitest";
import { cleanIpcError } from "./shell";

// 用正斜杠路径写断言：这些字符串要穿过多层工具，反斜杠一路上很容易被吃掉。
// 被测函数只管前缀，路径分隔符是什么无关紧要。
describe("cleanIpcError", () => {
  it("剥掉 Electron 的 IPC 包装，只留给用户看的那句", () => {
    const raw = "Error invoking remote method 'launch:start': Error: 目录不存在：C:/没有这个目录";
    expect(cleanIpcError(raw)).toBe("目录不存在：C:/没有这个目录");
  });

  it("只有 Error: 前缀时也剥掉", () => {
    expect(cleanIpcError("Error: 无法启动命令 grok")).toBe("无法启动命令 grok");
  });

  it("没有任何包装时原样返回", () => {
    expect(cleanIpcError("目录不存在：C:/x")).toBe("目录不存在：C:/x");
  });

  it("首尾空白被去掉", () => {
    expect(cleanIpcError("  Error: 出错了  ")).toBe("出错了");
  });
});
