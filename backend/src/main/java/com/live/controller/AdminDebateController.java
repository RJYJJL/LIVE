package com.live.controller;

import com.live.common.Result;
import com.live.service.MockDataService;
import com.live.websocket.LiveWebSocketHandler;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 辩题管理：CRUD、流关联
 */
@RestController
@RequestMapping("/api/v1/admin")
@RequiredArgsConstructor
public class AdminDebateController {

    private final MockDataService mock;

    @GetMapping("/debates/{debateId}")
    public Result<MockDataService.DebateDto> getDebate(@PathVariable String debateId) {
        MockDataService.DebateDto d = mock.getDebate(debateId);
        return d != null ? Result.ok(d) : Result.fail("辩题不存在");
    }

    @PostMapping("/debates")
    public Result<MockDataService.DebateDto> createDebate(@RequestBody Map<String, Object> body) {
        String id = body.containsKey("id") ? (String) body.get("id") : "debate-" + System.currentTimeMillis();
        MockDataService.DebateDto d = new MockDataService.DebateDto(
                id,
                (String) body.getOrDefault("title", ""),
                (String) body.getOrDefault("description", ""),
                (String) body.getOrDefault("leftPosition", ""),
                (String) body.getOrDefault("rightPosition", ""),
                body.containsKey("active") ? (Boolean) body.get("active") : true
        );
        mock.createDebate(d);
        LiveWebSocketHandler.broadcast("debate-updated", Map.of("debateId", id, "debate", d));
        return Result.ok(d);
    }

    @PutMapping("/debates/{debateId}")
    public Result<MockDataService.DebateDto> updateDebate(@PathVariable String debateId, @RequestBody Map<String, Object> body) {
        MockDataService.DebateDto existing = mock.getDebate(debateId);
        if (existing == null) return Result.fail("辩题不存在");
        MockDataService.DebateDto d = new MockDataService.DebateDto(
                debateId,
                (String) body.getOrDefault("title", existing.getTitle()),
                (String) body.getOrDefault("description", existing.getDescription()),
                (String) body.getOrDefault("leftPosition", existing.getLeftPosition()),
                (String) body.getOrDefault("rightPosition", existing.getRightPosition()),
                body.containsKey("isActive") ? (Boolean) body.get("isActive") : existing.isActive()
        );
        mock.updateDebate(debateId, d);
        LiveWebSocketHandler.broadcast("debate-updated", Map.of("debateId", debateId, "debate", d));
        return Result.ok(d);
    }
}
