package com.live.common;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * 统一 API 响应格式：{ "code": 0, "message": "success", "data": {...} }
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class Result<T> {
    private int code;
    private String message;
    private T data;
    /** 前端兼容：apiRequest 根据 success 取 data */
    private boolean success = true;

    public static <T> Result<T> ok(T data) {
        Result<T> r = new Result<>(0, "success", data, true);
        return r;
    }

    public static <T> Result<T> ok() {
        return ok(null);
    }

    public static <T> Result<T> fail(int code, String message) {
        return new Result<>(code, message, null, false);
    }

    public static <T> Result<T> fail(String message) {
        return fail(-1, message);
    }
}
