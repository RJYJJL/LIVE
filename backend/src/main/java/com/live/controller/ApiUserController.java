package com.live.controller;

import com.live.common.Result;
import com.live.service.MockDataService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 规范示例接口：GET /api/users 返回 mock 用户，POST /api/users 创建 mock 用户
 */
@RestController
@RequestMapping("/api")
@RequiredArgsConstructor
public class ApiUserController {

    private final MockDataService mock;

    @GetMapping("/users")
    public Result<Map<String, Object>> getUsers(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int pageSize) {
        List<Map<String, Object>> list = mock.getUsers(page, pageSize);
        int total = mock.getUsersTotal();
        Map<String, Object> data = new HashMap<>();
        data.put("list", list);
        data.put("total", total);
        data.put("page", page);
        data.put("pageSize", pageSize);
        return Result.ok(data);
    }

    @PostMapping("/users")
    public Result<Map<String, Object>> createUser(@RequestBody Map<String, Object> body) {
        String id = "user-" + System.currentTimeMillis();
        Map<String, Object> user = new HashMap<>(body);
        user.put("id", id);
        user.putIfAbsent("nickName", "微信用户");
        user.putIfAbsent("status", "active");
        user.putIfAbsent("createdAt", java.time.Instant.now().toString());
        user.putIfAbsent("updatedAt", java.time.Instant.now().toString());
        return Result.ok(Map.of("user", user, "message", "创建mock用户记录成功"));
    }
}
