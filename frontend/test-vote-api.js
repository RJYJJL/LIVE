/**
 * 投票接口诊断脚本
 * 用于测试真实后端服务器的投票接口
 * 在浏览器控制台中运行此脚本以诊断 403 问题
 */

console.log('🔍 开始投票接口诊断...\n');

const API_BASE = 'http://192.168.43.247:8000';
const TEST_STREAM_ID = 'stream-1'; // 根据实际修改

// 测试用例集合
const testCases = [
  {
    name: '测试1: 包装格式 + v1路径',
    url: `${API_BASE}/api/v1/user-vote`,
    data: {
      request: {
        leftVotes: 50,
        rightVotes: 50,
        streamId: TEST_STREAM_ID,
        stream_id: TEST_STREAM_ID
      }
    }
  },
  {
    name: '测试2: 直接格式 + v1路径',
    url: `${API_BASE}/api/v1/user-vote`,
    data: {
      leftVotes: 50,
      rightVotes: 50,
      streamId: TEST_STREAM_ID,
      stream_id: TEST_STREAM_ID
    }
  },
  {
    name: '测试3: 包装格式 + 非v1路径',
    url: `${API_BASE}/api/user-vote`,
    data: {
      request: {
        leftVotes: 50,
        rightVotes: 50,
        streamId: TEST_STREAM_ID,
        stream_id: TEST_STREAM_ID
      }
    }
  },
  {
    name: '测试4: 直接格式 + 非v1路径',
    url: `${API_BASE}/api/user-vote`,
    data: {
      leftVotes: 50,
      rightVotes: 50,
      streamId: TEST_STREAM_ID,
      stream_id: TEST_STREAM_ID
    }
  }
];

// 执行单个测试
async function runTest(testCase) {
  console.log(`\n📝 ${testCase.name}`);
  console.log(`   URL: ${testCase.url}`);
  console.log(`   Data: ${JSON.stringify(testCase.data, null, 2)}`);
  
  try {
    const response = await fetch(testCase.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(testCase.data)
    });
    
    console.log(`   📊 Status: ${response.status} ${response.statusText}`);
    console.log(`   Headers:`, {
      'content-type': response.headers.get('content-type'),
      'access-control-allow-origin': response.headers.get('access-control-allow-origin')
    });
    
    const responseData = await response.json();
    console.log(`   ✅ Response:`, responseData);
    
    return {
      success: response.status >= 200 && response.status < 300,
      status: response.status,
      data: responseData
    };
  } catch (error) {
    console.error(`   ❌ Error:`, error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

// 执行所有测试
async function runAllTests() {
  console.log('═══════════════════════════════════════');
  console.log('投票接口诊断 - 多格式测试');
  console.log('═══════════════════════════════════════');
  
  const results = [];
  
  for (const testCase of testCases) {
    const result = await runTest(testCase);
    results.push({
      name: testCase.name,
      ...result
    });
    
    // 等待1秒后再进行下一个测试
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // 总结结果
  console.log('\n═══════════════════════════════════════');
  console.log('📊 测试结果总结:');
  console.log('═══════════════════════════════════════');
  
  const successCount = results.filter(r => r.success).length;
  console.log(`✅ 成功: ${successCount}/${results.length}`);
  
  results.forEach((result, index) => {
    const status = result.success ? '✅' : '❌';
    console.log(`${status} ${result.name}`);
    if (result.status) {
      console.log(`   状态码: ${result.status}`);
    }
  });
  
  // 输出诊断建议
  console.log('\n═══════════════════════════════════════');
  console.log('💡 诊断建议:');
  console.log('═══════════════════════════════════════');
  
  if (successCount === 0) {
    console.log('⚠️  所有测试都失败了！');
    console.log('');
    console.log('可能的原因:');
    console.log('1. 后端服务器不可达 (网络问题或服务器宕机)');
    console.log('2. 后端需要特定的认证 (token, API key 等)');
    console.log('3. 后端有 CORS 配置限制');
    console.log('4. 后端 IP 白名单限制 (只允许特定 IP)');
  } else if (successCount === results.length) {
    console.log('✅ 所有测试都成功了！投票接口正常。');
  } else {
    console.log('⚠️  部分测试成功，部分失败。');
    const failedTests = results.filter(r => !r.success);
    console.log('失败的测试:');
    failedTests.forEach(t => {
      console.log(`  - ${t.name}`);
      if (t.error) console.log(`    错误: ${t.error}`);
      if (t.status === 403) console.log(`    💡 403 错误通常表示权限/认证问题或 CORS 配置问题`);
    });
  }
}

// 启动测试
runAllTests().then(() => {
  console.log('\n✅ 诊断完成！');
});

