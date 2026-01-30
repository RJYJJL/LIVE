package com.live.controller;

import com.live.common.Result;
import com.live.service.MockDataService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 辩论流程：GET/POST /api/admin/debate-flow, POST /api/admin/debate-flow/control
 */
@RestController
@RequestMapping("/api/admin")
@RequiredArgsConstructor
public class DebateFlowController {

    private final MockDataService mock;

    @GetMapping("/debate-flow")
    public Result<Map<String, Object>> getDebateFlow(@RequestParam(required = false) String stream_id) {
        String sid = stream_id != null ? stream_id : (mock.getStreams().isEmpty() ? null : mock.getStreams().get(0).getId());
        if (sid == null) return Result.ok(Map.of("segments", List.of()));
        List<Map<String, Object>> segments = mock.getDebateFlow(sid);
        return Result.ok(Map.of("stream_id", sid, "segments", segments));
    }

    @PostMapping("/debate-flow")
    public Result<Map<String, Object>> saveDebateFlow(@RequestBody Map<String, Object> body) {
        String streamId = (String) body.get("stream_id");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> segments = (List<Map<String, Object>>) body.get("segments");
        if (streamId == null || segments == null) return Result.fail("stream_id 与 segments 必填");
        mock.setDebateFlow(streamId, segments);
        return Result.ok(Map.of("stream_id", streamId, "saved", true));
    }

    @PostMapping("/debate-flow/control")
    public Result<Map<String, Object>> control(@RequestBody Map<String, Object> body) {
        String streamId = (String) body.get("stream_id");
        String action = (String) body.get("action");
        return Result.ok(Map.of("stream_id", streamId, "action", action, "message", "命令已接收"));
    }
}
