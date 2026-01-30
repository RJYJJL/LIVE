package com.live.controller;

import com.live.common.Result;
import com.live.service.MockDataService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 后台用户与投票统计：GET /api/admin/miniprogram/users, GET /api/admin/votes/statistics
 */
@RestController
@RequiredArgsConstructor
public class AdminUserController {

    private final MockDataService mock;

    @GetMapping("/api/admin/miniprogram/users")
    public Result<Map<String, Object>> listUsers(
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

    @GetMapping("/api/admin/votes/statistics")
    public Result<Map<String, Object>> votesStatistics(@RequestParam(defaultValue = "1h") String timeRange) {
        int totalLeft = 0, totalRight = 0;
        for (String sid : mock.getStreams().stream().map(MockDataService.StreamInfo::getId).toList()) {
            MockDataService.VoteState v = mock.getVotes(sid);
            totalLeft += v.getLeftVotes();
            totalRight += v.getRightVotes();
        }
        Map<String, Object> data = new HashMap<>();
        data.put("timeRange", timeRange);
        data.put("totalLeftVotes", totalLeft);
        data.put("totalRightVotes", totalRight);
        data.put("totalVotes", totalLeft + totalRight);
        data.put("dailyStats", List.of());
        return Result.ok(data);
    }
}
