package com.live.controller;

import com.live.common.Result;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 根路径说明：8000 为 API 服务，请用网关 8080 打开管理页
 */
@RestController
public class RootController {

    @GetMapping("/")
    public Result<Map<String, String>> root() {
        return Result.ok(Map.of(
                "message", "本服务为 API 后端（端口 8000），不提供网页。",
                "admin", "请打开网关地址进入管理页：http://localhost:8080/admin 或 http://192.168.43.247:8080/admin",
                "api", "/api/* 为接口路径"
        ));
    }
}
