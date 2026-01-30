package com.live.controller;

import com.live.common.Result;
import com.live.service.MockDataService;
import com.live.websocket.LiveWebSocketHandler;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.Map;

/**
 * 后台数据概览：GET /api/v1/admin/dashboard?stream_id=
 */
@RestController
@RequestMapping("/api/v1/admin")
@RequiredArgsConstructor
public class AdminDashboardController {

    private final MockDataService mock;

    @GetMapping("/dashboard")
    public Result<Map<String, Object>> dashboard(@RequestParam(required = false) String stream_id) {
        String sid = stream_id != null ? stream_id : mock.getStreams().isEmpty() ? null : mock.getStreams().get(0).getId();
        if (sid == null) {
            return Result.fail("请指定 stream_id 或先添加直播流");
        }
        MockDataService.VoteState v = mock.getVotes(sid);
        Map<String, Object> data = new HashMap<>();
        data.put("streamId", sid);
        data.put("isLive", mock.isLive(sid));
        data.put("aiStatus", mock.getAiStatus(sid));
        data.put("leftVotes", v.getLeftVotes());
        data.put("rightVotes", v.getRightVotes());
        data.put("viewers", mock.getViewers(sid));
        MockDataService.DebateDto deb = mock.getStreamDebate(sid);
        if (deb != null) {
            data.put("debateTopic", deb.getTitle());
            data.put("leftPosition", deb.getLeftPosition());
            data.put("rightPosition", deb.getRightPosition());
        }
        return Result.ok(data);
    }
}
